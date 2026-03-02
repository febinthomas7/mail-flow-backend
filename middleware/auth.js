import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET; // Must match your login function

export const authMiddleware = (req, res, next) => {
  // 1. Get token from cookies
  const token = req.cookies.auth_token;

  // 2. If no token, block access
  if (!token) {
    res.status(401).json({
      success: false,
      message: "Access Denied: No token provided",
    });
    return;
  }

  try {
    // 3. Verify the token
    const decoded = jwt.verify(token, JWT_SECRET);

    // 4. Attach user data to request object (optional but helpful)
    req.user = decoded;

    // 5. Success! Move to the next function/route
    next();
  } catch (error) {
    // If token is expired or fake
    res.status(403).json({
      success: false,
      message: "Invalid or Expired Token",
    });
  }
};

// module.exports = { authMiddleware };
