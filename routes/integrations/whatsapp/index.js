import express from "express";
import verifyJWT from "../../../middleware/auth.js";
import webhookRouter from "./webhook.js";
import testRouter from "./test.js";

const router = express.Router();

// Webhook Meta (public, without JWT)
router.use("/webhook", webhookRouter);

// Connection test (authenticated)
router.use("/", verifyJWT, testRouter);

export default router;
