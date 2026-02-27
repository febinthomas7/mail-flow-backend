require("dotenv").config();
const express = require("express");
const cors = require("cors");
// const emailRoutes = require("./route/email");
const sendEmail = require("./route/email");
const verifyRoutes = require("./route/varify");
const axios = require("axios");
const app = express();
const PORT = process.env.PORT || 3001;
console.log(process.env.BASE_URL);

const allowedOrigins = [process.env.BASE_URL];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like mobile apps or curl requests)
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
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use("/api/send-email", sendEmail);

app.post("/api/send", (req, res) => {
  console.log("hit");
  res.status(200).json({
    success: true,
  });
});

// const http = require('http'); // Changed from https
// const fs = require('fs');

// const data = JSON.stringify({
//     html: '<h1>MedLock AWS Test</h1>',
// });

// const options = {
//     hostname: '54.234.217.28', // Your Public IP
//     port: 80,                  // Standard Port
//     path: '/make-pdf',
//     method: 'POST',
//     headers: {
//         'Content-Type': 'application/json',
//         'Content-Length': Buffer.byteLength(data),
//     },
// };

// const req = http.request(options, res => {
//     let body = Buffer.alloc(0);
//     res.on('data', chunk => body = Buffer.concat([body, chunk]));
//     res.on('end', () => {
//         fs.writeFile('medlock_test.pdf', body, (err) => {
//             if (!err) console.log("File saved successfully!");
//         });
//     });
// });

// req.on('error', console.error);
// req.write(data);
// req.end();

app.listen(PORT, () => {
  console.log(`
    ==============================================
    MAILFLOW PRO BACKEND STARTED
    Port: ${PORT}
    Status: READY FOR RELAY
    ==============================================
    `);
});
