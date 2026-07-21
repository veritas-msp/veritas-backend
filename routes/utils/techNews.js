import express from "express";
import { body, param, validationResult } from "express-validator";
import verifyJWT from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { requirePro } from "../../middleware/edition.js";
import { getTechNewsFeed, clearTechNewsCache } from "../../utils/techNewsFeed.js";
import { ALLOWED_REACTION_EMOJIS, addReactionStreamClient, broadcastReactionHeartbeat, ensureTechNewsReactionsTable, getReactionsForArticles, removeReactionStreamClient, toggleTechNewsReaction } from "../../utils/techNewsReactions.js";
import { ALLOWED_FEED_CATEGORIES, createTechNewsFeed, deleteTechNewsFeed, getTechNewsFeedsMeta, listTechNewsFeeds, resetTechNewsFeedsForLocale, updateTechNewsFeed } from "../../utils/techNewsFeedsConfig.js";
const router = express.Router();
function handleFeedError(res, err, context) {
  console.error(context, err);
  res.status(err.status || 500).json({
    error: err.message || "Server error."
  });
}
router.get("/feeds/meta", verifyJWT, requireRole("admin"), requirePro, (_req, res) => {
  res.json(getTechNewsFeedsMeta());
});
router.get("/feeds", verifyJWT, requireRole("admin"), requirePro, async (req, res) => {
  try {
    const locale = req.query.locale || "fr";
    const feeds = await listTechNewsFeeds(locale);
    res.json({
      locale,
      feeds
    });
  } catch (err) {
    handleFeedError(res, err, "GET /tech-news/feeds");
  }
});
router.post("/feeds", verifyJWT, requireRole("admin"), requirePro, [body("locale").optional().isString(), body("source").isString().trim().notEmpty(), body("url").isString().trim().notEmpty(), body("category").optional().isIn(ALLOWED_FEED_CATEGORIES), body("enabled").optional().isBoolean(), body("sortOrder").optional().isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Invalid request",
      details: errors.array()
    });
  }
  try {
    const feed = await createTechNewsFeed(req.body);
    clearTechNewsCache();
    res.status(201).json({
      feed
    });
  } catch (err) {
    handleFeedError(res, err, "POST /tech-news/feeds");
  }
});
router.post("/feeds/reset", verifyJWT, requireRole("admin"), requirePro, async (req, res) => {
  try {
    const locale = req.query.locale || req.body?.locale || "fr";
    const feeds = await resetTechNewsFeedsForLocale(locale);
    clearTechNewsCache();
    res.json({
      locale,
      feeds
    });
  } catch (err) {
    handleFeedError(res, err, "POST /tech-news/feeds/reset");
  }
});
router.patch("/feeds/:id", verifyJWT, requireRole("admin"), requirePro, [param("id").isInt({
  min: 1
}), body("source").optional().isString().trim().notEmpty(), body("url").optional().isString().trim().notEmpty(), body("category").optional().isIn(ALLOWED_FEED_CATEGORIES), body("enabled").optional().isBoolean(), body("sortOrder").optional().isInt()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Invalid request",
      details: errors.array()
    });
  }
  try {
    const feed = await updateTechNewsFeed(req.params.id, req.body);
    clearTechNewsCache();
    res.json({
      feed
    });
  } catch (err) {
    handleFeedError(res, err, "PATCH /tech-news/feeds/:id");
  }
});
router.delete("/feeds/:id", verifyJWT, requireRole("admin"), requirePro, [param("id").isInt({
  min: 1
})], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Invalid request",
      details: errors.array()
    });
  }
  try {
    await deleteTechNewsFeed(req.params.id);
    clearTechNewsCache();
    res.json({
      success: true
    });
  } catch (err) {
    handleFeedError(res, err, "DELETE /tech-news/feeds/:id");
  }
});
router.get("/", verifyJWT, async (req, res) => {
  try {
    const locale = req.query.locale || "fr";
    const data = await getTechNewsFeed(locale);
    res.json(data);
  } catch (err) {
    console.error("GET /tech-news", err);
    res.status(500).json({
      error: "Unable to load news."
    });
  }
});
router.get("/reactions", verifyJWT, async (req, res) => {
  try {
    const raw = req.query.ids || req.query.articleIds || "";
    const articleIds = String(raw).split(",").map(id => id.trim()).filter(Boolean);
    const data = await getReactionsForArticles(articleIds, req.user?.id);
    res.json({
      emojis: ALLOWED_REACTION_EMOJIS,
      ...data
    });
  } catch (err) {
    console.error("GET /tech-news/reactions", err);
    res.status(500).json({
      error: "Unable to load reactions."
    });
  }
});
router.post("/reactions", verifyJWT, [body("articleId").isString().trim().notEmpty(), body("emoji").isString().trim().isIn(ALLOWED_REACTION_EMOJIS)], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: "Invalid request",
      details: errors.array()
    });
  }
  try {
    const result = await toggleTechNewsReaction(req.body.articleId, req.user.id, req.body.emoji);
    res.json(result);
  } catch (err) {
    console.error("POST /tech-news/reactions", err);
    res.status(err.status || 500).json({
      error: err.message || "Reaction error."
    });
  }
});
router.get("/reactions/stream", verifyJWT, async (req, res) => {
  try {
    await ensureTechNewsReactionsTable();
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({
      type: "connected"
    })}\n\n`);
    addReactionStreamClient(res);
    const heartbeat = setInterval(() => {
      broadcastReactionHeartbeat();
    }, 25000);
    req.on("close", () => {
      clearInterval(heartbeat);
      removeReactionStreamClient(res);
    });
  } catch (err) {
    console.error("GET /tech-news/reactions/stream", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Realtime stream unavailable."
      });
    }
  }
});
export default router;
