import { startSession, stopSession, getQRCode, updateSessionConfig, deleteSession, getPendingMessages } from '../../manager.js';

export default class SessionService {
    constructor(sessionRepository) {
        this.sessionRepository = sessionRepository;
    }

    async createSession(sessionId, sourceGroupPrefix, targetGroupPrefix) {
        // Configura os prefixos ANTES de iniciar a sessão
        if (sourceGroupPrefix && targetGroupPrefix) {
            updateSessionConfig(sessionId, {
                sourceGroupPrefix,
                targetGroupPrefix
            });
            console.log(`✅ Prefixos configurados para ${sessionId}:`);
            console.log(`   📤 Origem: "${sourceGroupPrefix}"`);
            console.log(`   📥 Destino: "${targetGroupPrefix}"`);
        }

        await startSession(sessionId);

        const session = await this.sessionRepository.createSession(sessionId, sourceGroupPrefix, targetGroupPrefix);
        return session;
    }

    async startSession(sessionId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }
        const statusSession = existsSession[0].status;
        if (statusSession) {
            throw new Error('Sessão já ativa');
        }

        startSession(sessionId);

        return { ok: true };
    }

    async stopSession(sessionId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }
        const statusSession = existsSession[0].status;
        if (!statusSession) {
            throw new Error('Sessão já parada');
        }

        stopSession(sessionId);

        await this.sessionRepository.stopSession(sessionId);
        return { ok: true };
    }

    async listSessions() {
        return this.sessionRepository.listSessions();
    }

    async deleteSession(sessionId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }
        if (existsSession[0].status) {
            await stopSession(sessionId);
        }
        await deleteSession(sessionId);
        await this.sessionRepository.deleteSession(sessionId);
        return { ok: true };
    }

    async getQRCode(sessionId) {
        return getQRCode(sessionId);
    }

    async updateSessionConfig(sessionId, sourceGroup, targetGroup, delayMs) {
        updateSessionConfig(sessionId, {
            sourceGroup,
            targetGroup,
            delayMs
        });

        return this.sessionRepository.updateSessionConfig(sessionId, sourceGroup, targetGroup);
    }

    getPendingMessages(sessionId) {
        return getPendingMessages(sessionId);
    }
}