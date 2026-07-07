import express from "express";
import verifyJWT from "../../../middleware/auth.js";
import webhookRouter from "./webhook.js";
import testRouter from "./test.js";

const router = express.Router();

// Webhook Meta (public, sans JWT)
router.use("/webhook", webhookRouter);

// Test de connexion (authentifié)
router.use("/", verifyJWT, testRouter);

export default router;
