require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const cookieParser = require("cookie-parser"); // 1. REQUIRE THIS

const sendEmail = require("./route/email");
const verify = require("./route/varify");
const login = require("./route/auth");
const { authMiddleware } = require("./middleware/auth");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// Initialize Socket.io
// const io = new Server(server, {
//   cors: {
//     origin: process.env.BASE_URL,
//     methods: ["GET", "POST"],
//     credentials: true, // 2. ALLOW COOKIES IN SOCKETS
//   },
// });

const io = new Server(server, {
  cors: {
    origin: process.env.BASE_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
  // Adding these helps stabilize the connection through proxies
  transports: ["polling", "websocket"],
  allowEIO3: true,
});

app.use(cookieParser()); // 3. USE IT HERE (Before routes)
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

const allowedOrigins = [process.env.BASE_URL];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        return callback(new Error("CORS policy blocked access."), false);
      }
      return callback(null, true);
    },
    credentials: true, // 4. CRITICAL: Allow browser to send cookies
  }),
);

app.set("socketio", io);

// --- ROUTES ---

// Public Route: No middleware here so people can actually log in!
app.use("/api/login", login);

// Protected Routes: Middleware applied here
app.use("/api/send-email", authMiddleware, sendEmail);
app.use("/api/verify", authMiddleware, verify);

// Define these globally or export them from a 'state' file
global.isPaused = false;
global.limitReached = false;
global.isReset = false;
io.on("connection", (socket) => {
  console.log(`📡 Socket Connected: ${socket.id}`);

  // ⏸️ PAUSE
  socket.on("pause_dispatch", () => {
    global.isPaused = true;
    console.log("⏸️ Dispatch PAUSED");
    io.emit("status_update", { status: "paused" });
  });

  // ▶️ RESUME
  socket.on("resume_dispatch", () => {
    global.isPaused = false;
    console.log("▶️ Dispatch RESUMED");
    io.emit("status_update", { status: "sending" });
  });

  // 🔄 RESET
  socket.on("reset_dispatch", () => {
    global.isPaused = false;
    global.limitReached = false;
    global.isReset = true;
    console.log("🔄 Dispatch RESET");

    io.emit("dispatch_reset", {
      processed: 0, // Add this
      total: 0, // Add this
      percentage: 0,
      lastEmail: null,
      status: "ready",
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket Disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`
    ==============================================
    MAILFLOW PRO BACKEND STARTED
    Port: ${PORT}
    ==============================================
    `);
});
