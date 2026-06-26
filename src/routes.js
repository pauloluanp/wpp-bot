import express from "express";
import { makeSessionController } from "./modules/session/session.module.js";
import { getTelegramStatus } from "./manager.js";
import { moduleCategory } from "./modules/categories/category.module.js";

const router = express.Router();
const sessionController = makeSessionController();
const categoryController = moduleCategory();

router.post("/categories", categoryController.createCategory);
router.post("/sessions", sessionController.createSession);
router.get("/sessions", sessionController.listSessions);

router.patch("/sessions/:id/start", sessionController.startSession);
router.patch("/sessions/:id/stop", sessionController.stopSession);

router.delete("/sessions/:id", sessionController.deleteSession);

router.get("/sessions/:id/qrcode", sessionController.getQRCode);

router.post("/sessions/:id/config", sessionController.updateSessionConfig);

router.get("/sessions/:id/pending", sessionController.getPendingMessages);

router.get("/telegram/groups", async (req, res) => {
  try {
    const status = await getTelegramStatus();
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
