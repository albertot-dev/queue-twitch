import { app, BrowserWindow, ipcMain, shell } from "electron";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import Store from "electron-store";
import open from "open";

import { ApiClient } from "@twurple/api";
import { StaticAuthProvider } from "@twurple/auth";
import { EventSubWsListener } from "@twurple/eventsub-ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const store = new Store();

let CLIENT_ID = store.get("twitch_client_id") || "";
const REDIRECT_URI = "http://localhost:3000/callback";

let cola = [];
let jugando = Array(store.get("maxSlots") || 3).fill(null);
let apiClient, listener, mainWindow;

const exApp = express();
const server = createServer(exApp);
const io = new Server(server);

io.on("connection", (socket) => {
  socket.emit("update", { cola, jugando });
});

exApp.use(express.static(__dirname));

exApp.get("/callback", (req, res) => {
  res.sendFile(path.join(__dirname, "callback.html"));
});

exApp.get("/save-token", (req, res) => {
  const token = req.query.token;
  if (token) {
    mainWindow.webContents.send("token-recibido", token);
    res.send("<h1>Autorizado</h1><script>window.close()</script>");
  } else {
    res.sendStatus(400);
  }
});

server.listen(3000);

function broadcastUpdate() {
  const data = { cola, jugando };
  io.emit("update", data);
  if (mainWindow) mainWindow.webContents.send("update-ui", data);
}

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: "#0e0e10",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile("index.html");
  mainWindow.webContents.on("did-finish-load", () => {
    broadcastUpdate();
    if (!store.get("twitch_client_id")) {
      mainWindow.webContents.send("necesita-config");
    }
  });
});

ipcMain.on("guardar-client-id", (e, nuevoId) => {
  store.set("twitch_client_id", nuevoId);
  CLIENT_ID = nuevoId;
  console.log("Nuevo Client ID configurado:", CLIENT_ID);
});

ipcMain.on("iniciar-login", () => {
  const scopes = "channel:read:redemptions chat:read";
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "token",
    scope: scopes,
  });
  open(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
});

ipcMain.on("conectar-con-token", async (e, { token, rewardName }) => {
  try {
    console.log("Conectando...");
    const authProvider = new StaticAuthProvider(CLIENT_ID, token);
    apiClient = new ApiClient({ authProvider });

    const tokenInfo = await apiClient.getTokenInfo();
    const me = await apiClient.users.getUserById(tokenInfo.userId);

    if (listener) await listener.stop();
    listener = new EventSubWsListener({ apiClient });
    await listener.start();

    try {
      await listener.onChannelRewardRedemptionAdd(me.id, async (event) => {
        procesarCanje(
          event.rewardTitle,
          rewardName,
          event.userId,
          event.userDisplayName,
        );
      });
    } catch (subError) {
      await listener.on(
        "channel.channel_points_custom_reward_redemption.add",
        { broadcaster_user_id: me.id },
        async (event) => {
          procesarCanje(
            event.rewardTitle,
            rewardName,
            event.userId,
            event.userDisplayName,
          );
        },
      );
    }

    console.log("Escuchando puntos de canal...");
    store.set("accessToken", token);
    e.reply("twitch-status", `Conectado como ${me.displayName}`);
  } catch (err) {
    console.error(err);
    e.reply("twitch-status", "Error: " + err.message);
  }
});

async function procesarCanje(title, rewardName, userId, userName) {
  if (title.trim().toLowerCase() === rewardName.trim().toLowerCase()) {
    const user = await apiClient.users.getUserById(userId);
    cola.push({
      id: userId,
      name: userName,
      avatar: user ? user.profilePictureUrl : "",
      startTime: null,
    });
    broadcastUpdate();
  }
}

ipcMain.on("test-canje", (e) => {
  cola.push({
    id: "test-" + Date.now(),
    name: "Tester_" + Math.floor(Math.random() * 100),
    avatar: `https://robohash.org/${Math.random()}?set=set4`,
    startTime: null,
  });
  broadcastUpdate();
});

ipcMain.on("configurar-slots", (e, num) => {
  const n = parseInt(num);
  store.set("maxSlots", n);
  jugando = Array(n).fill(null);
  broadcastUpdate();
});

ipcMain.on("subir-jugador", (e, index) => {
  const slotVacio = jugando.findIndex((s) => s === null);
  if (slotVacio !== -1 && cola[index]) {
    const p = cola.splice(index, 1)[0];
    p.startTime = Date.now();
    jugando[slotVacio] = p;
    broadcastUpdate();
  }
});

ipcMain.on("finalizar-jugador", (e, index) => {
  jugando[index] = null;
  broadcastUpdate();
});

ipcMain.on("eliminar-cola", (e, index) => {
  cola.splice(index, 1);
  broadcastUpdate();
});
