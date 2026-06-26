import { startSession, stopSession, getQRCode, updateSessionConfig, deleteSession, getPendingMessages } from '../../manager.js';

export default class SessionService {
    constructor(sessionRepository) {
        this.sessionRepository = sessionRepository;
    }

    async createSession(userId, sessionId, sourceGroupPrefix, targetGroupPrefix) {
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

        const session = await this.sessionRepository.createSession(
            userId,
            sessionId,
            sourceGroupPrefix,
            targetGroupPrefix
        );
        return session;
    }

    async startSession(sessionId, userId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }

        // Se a sessão já estiver ativa no banco, ainda assim chamamos o startSession no manager
        // O manager se encarregará de verificar se ela já está rodando em memória
        await startSession(sessionId);

        return { ok: true };
    }

    async stopSession(sessionId, userId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }
        const statusSession = existsSession[0].status;
        if (!statusSession) {
            throw new Error('Sessão já parada');
        }

        stopSession(sessionId);

        await this.sessionRepository.stopSession(sessionId, userId);
        return { ok: true };
    }

    async listSessions(userId) {
        return this.sessionRepository.listSessions(userId);
    }

    async deleteSession(sessionId, userId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }
        if (existsSession[0].status) {
            await stopSession(sessionId);
        }
        await deleteSession(sessionId);
        await this.sessionRepository.deleteSession(sessionId, userId);
        return { ok: true };
    }

    async getQRCode(sessionId, userId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }

        return getQRCode(sessionId);
    }

    async updateSessionConfig(sessionId, userId, sourceGroup, targetGroup, delayMs) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }

        updateSessionConfig(sessionId, {
            sourceGroup,
            targetGroup,
            sourceGroupPrefix: sourceGroup,
            targetGroupPrefix: targetGroup,
            delayMs
        });

        return this.sessionRepository.updateSessionConfig(
            sessionId,
            userId,
            sourceGroup,
            targetGroup
        );
    }

    async getPendingMessages(sessionId, userId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }

        return getPendingMessages(sessionId);
    }
}
