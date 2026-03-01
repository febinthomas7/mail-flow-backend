require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http"); // <--- ADD THIS LINE
const { Server } = require("socket.io");
// const emailRoutes = require("./route/email");
const sendEmail = require("./route/email");
// const verifyRoutes = require("./route/varify");
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// 1. Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: process.env.BASE_URL,
    methods: ["GET", "POST"],
  },
});
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
const allowedOrigins = [process.env.BASE_URL];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg =
          "The CORS policy for this site does not allow access from the specified Origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  }),
);
app.set("socketio", io);
app.use("/api/send-email", sendEmail);

app.post("/api/send", (req, res) => {
  console.log("hit");
  res.status(200).json({
    success: true,
  });
});
io.on("connection", (socket) => {
  console.log(`📡 Socket Connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log("❌ Socket Disconnected");
  });
});
server.listen(PORT, () => {
  console.log(`
    ==============================================
    MAILFLOW PRO BACKEND STARTED
    Port: ${PORT}
    Status: READY FOR RELAY
    ==============================================
    `);
});
