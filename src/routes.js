import express from "express";
import { makeSessionController } from "./modules/session/session.module.js";
import { getTelegramStatus } from "./manager.js";
import { makeUserController } from "./modules/users/user.module.js";
import { makeFolderController } from "./modules/folders/folder.module.js";
import { makePlanModule } from "./modules/plans/plan.module.js";
import { makeMlCredentialController } from "./modules/mlCredentials/mlCredential.module.js";
import { authMiddleware } from "./middlewares/auth.middleware.js";
import { adminMiddleware } from "./middlewares/admin.middleware.js";

const router = express.Router();
const sessionController = makeSessionController();
const userController = makeUserController();
const folderController = makeFolderController();
const { planController } = makePlanModule();
const mlCredentialController = makeMlCredentialController();

// Criação/listagem de usuários é restrita a administradores.
router.post("/users", authMiddleware, adminMiddleware, userController.createUser);
router.get("/users", authMiddleware, adminMiddleware, userController.listUsers);
router.post("/login", userController.login);

// Planos
router.get("/plans", planController.listPlans);

// Perfil do usuário logado
router.get("/me", authMiddleware, userController.getMe);
router.patch("/me", authMiddleware, userController.updateProfile);
router.patch("/me/password", authMiddleware, userController.changePassword);
// Obs.: a troca de plano NÃO é self-service (o pagamento vem antes). O usuário
// é encaminhado ao WhatsApp e o plano é aplicado via script de admin (db:set-plan).

// Pastas (usadas pelo front para organizar as margens/sessões)
router.get("/folders", authMiddleware, folderController.listFolders);
router.post("/folders", authMiddleware, folderController.createFolder);

router.post("/sessions", authMiddleware, sessionController.createSession);
router.get("/sessions", authMiddleware, sessionController.listSessions);

router.patch("/sessions/:id/start", authMiddleware, sessionController.startSession);
router.patch("/sessions/:id/stop", authMiddleware, sessionController.stopSession);

router.delete("/sessions/:id", authMiddleware, sessionController.deleteSession);

router.get("/sessions/:id/qrcode", authMiddleware, sessionController.getQRCode);

router.post("/sessions/:id/config", authMiddleware, sessionController.updateSessionConfig);

// Link de grupo (convite) da margem — anexado/substituído no final das mensagens.
router.put("/sessions/:id/group-invite", authMiddleware, sessionController.updateGroupInvite);

router.get("/sessions/:id/pending", authMiddleware, sessionController.getPendingMessages);

// Disparo manual de promoção (tela "Criar promoção"): recebe a imagem em base64
// e a legenda já pronta, e envia nos grupos de destino da margem. `:id` é o nome
// da margem (sessions.sessionId).
router.post("/sessions/:id/send", authMiddleware, sessionController.sendPromo);

// Credenciais do Mercado Livre por margem (o service exige plano premium e que a
// margem pertença ao usuário). `:id` é o nome da margem (sessions.sessionId).
router.get("/sessions/:id/ml-credentials", authMiddleware, mlCredentialController.getCredentials);
router.put("/sessions/:id/ml-credentials", authMiddleware, mlCredentialController.saveCredentials);

router.get("/telegram/groups", async (req, res) => {
  try {
    const status = await getTelegramStatus();
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
