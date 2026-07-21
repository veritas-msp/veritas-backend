import express from "express";
import verifyJWT from "../../../middleware/auth.js";
import webhookRouter from "./webhook.js";
import testRouter from "./test.js";
const router = express.Router();
router.use("/webhook", webhookRouter);
router.use("/", verifyJWT, testRouter);
export default router;
