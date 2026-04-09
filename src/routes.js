import express from 'express';
import { makeSessionController } from './modules/session/session.module.js';

const router = express.Router();
const sessionController = makeSessionController();

router.post('/sessions', sessionController.createSession);
router.get('/sessions', sessionController.listSessions);

router.patch('/sessions/:id/start', sessionController.startSession);
router.patch('/sessions/:id/stop', sessionController.stopSession);

router.delete('/sessions/:id', sessionController.deleteSession);

router.get('/sessions/:id/qrcode', sessionController.getQRCode);

router.post('/sessions/:id/config', sessionController.updateSessionConfig);

router.get('/sessions/:id/pending', sessionController.getPendingMessages);

export default router;
