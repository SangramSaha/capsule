// backend/index.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { RekognitionClient, DetectLabelsCommand } = require("@aws-sdk/client-rekognition");
const User = require("./models/User");
const Capsule = require("./models/Capsule");
const authRoutes = require("./routes/auth");
const capsuleRoutes = require("./routes/capsules");
const crypto = require("crypto");
const path = require("path");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { createClient } = require("redis");

dotenv.config();
const app = express();

// AWS S3 Setup
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// AWS Rekognition Setup for AI-based Image Labeling
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Redis Cache Setup for Performance
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

// Middleware
app.use(cors());
app.use(express.json());
app.use(compression());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
});
app.use(limiter);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/capsules", capsuleRoutes);

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const token = req.header("Authorization");
  if (!token) return res.status(401).json({ message: "Access Denied" });
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ message: "Invalid Token" });
  }
};

// Multer Storage Setup
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Upload Media to S3 & Perform AI-based Image Labeling
app.post("/api/upload", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file uploaded" });

    const fileName = `${crypto.randomUUID()}${path.extname(file.originalname)}`;
    const uploadParams = {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
    };
    await s3.send(new PutObjectCommand(uploadParams));
    const fileUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

    // AI Label Detection
    const rekognitionParams = {
      Image: { Bytes: file.buffer },
      MaxLabels: 5,
    };
    const { Labels } = await rekognition.send(new DetectLabelsCommand(rekognitionParams));
    const detectedLabels = Labels.map(label => label.Name);

    res.json({ fileUrl, detectedLabels });
  } catch (err) {
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
});

// Capsule Creation with Media URL
app.post("/api/capsules/create", authenticateToken, async (req, res) => {
  try {
    const { title, content, media, releaseDate } = req.body;
    const newCapsule = new Capsule({
      user: req.user.id,
      title,
      content,
      media,
      releaseDate,
    });
    await newCapsule.save();
    res.status(201).json({ message: "Capsule created successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// Fetch User Capsules with Redis Caching
app.get("/api/capsules", authenticateToken, async (req, res) => {
  try {
    const cacheKey = `capsules_${req.user.id}`;
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) return res.json(JSON.parse(cachedData));
    
    const capsules = await Capsule.find({ user: req.user.id });
    await redisClient.setEx(cacheKey, 3600, JSON.stringify(capsules));
    res.json(capsules);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error(err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
