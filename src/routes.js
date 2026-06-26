import express from "express";
import { makeSessionController } from "./modules/session/session.module.js";
import { getTelegramStatus } from "./manager.js";
import { moduleCategory } from "./modules/categories/category.module.js";
import { makeUserController } from "./modules/users/user.module.js";
import { authMiddleware } from "./middlewares/auth.middleware.js";

const router = express.Router();
const sessionController = makeSessionController();
const categoryController = moduleCategory();
const userController = makeUserController();

router.post("/users", userController.createUser);
router.post("/login", userController.login);

router.post("/categories", authMiddleware, categoryController.createCategory);
router.get("/categories", authMiddleware, categoryController.listCategories);
router.post("/sessions", authMiddleware, sessionController.createSession);
router.get("/sessions", authMiddleware, sessionController.listSessions);

router.patch("/sessions/:id/start", authMiddleware, sessionController.startSession);
router.patch("/sessions/:id/stop", authMiddleware, sessionController.stopSession);

router.delete("/sessions/:id", authMiddleware, sessionController.deleteSession);

router.get("/sessions/:id/qrcode", authMiddleware, sessionController.getQRCode);

router.post("/sessions/:id/config", authMiddleware, sessionController.updateSessionConfig);

router.get("/sessions/:id/pending", authMiddleware, sessionController.getPendingMessages);

router.get("/telegram/groups", async (req, res) => {
  try {
    const status = await getTelegramStatus();
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
