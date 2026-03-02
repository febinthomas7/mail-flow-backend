import jwt from "jsonwebtoken";
const ADMIN_ID = process.env.ADMIN_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
export const Login = async (req, res) => {
  const { id, password } = req.body;

  if (id === ADMIN_ID && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: "24h" });

    // Set the cookie
    res.cookie("auth_token", token, {
      httpOnly: true, // Prevents JavaScript from reading the cookie
      secure: process.env.NODE_ENV === "production", // Only sends over HTTPS in production
      sameSite: "strict", // Prevents CSRF attacks
      maxAge: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
    });

    res.status(200).json({ success: true, message: "Logged in successfully" });
  } else {
    res.status(401).json({ success: false, message: "Invalid credentials" });
  }
};

// module.exports = Login;
