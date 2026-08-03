import { startSession, stopSession, getQRCode, updateSessionConfig, deleteSession, getPendingMessages } from '../../manager.js';

export default class SessionService {
    constructor(sessionRepository) {
        this.sessionRepository = sessionRepository;
    }

    async createSession(userId, sessionId, sourceGroupPrefix, targetGroupPrefix, folderId = null, groupInviteLink = null) {
        const normalizedInvite = (groupInviteLink || '').trim() || null;

        // Configura os prefixos e o link de grupo ANTES de iniciar a sessão. A
        // conversão do Mercado Livre não é escolhida aqui: passa a valer quando a
        // margem ganha credenciais.
        updateSessionConfig(sessionId, {
            ...(sourceGroupPrefix && targetGroupPrefix
                ? { sourceGroupPrefix, targetGroupPrefix }
                : {}),
            groupInviteLink: normalizedInvite,
        });
        if (sourceGroupPrefix && targetGroupPrefix) {
            console.log(`✅ Prefixos configurados para ${sessionId}:`);
            console.log(`   📤 Origem: "${sourceGroupPrefix}"`);
            console.log(`   📥 Destino: "${targetGroupPrefix}"`);
        }

        await startSession(sessionId);

        const session = await this.sessionRepository.createSession(
            userId,
            sessionId,
            sourceGroupPrefix,
            targetGroupPrefix,
            folderId,
            normalizedInvite
        );
        return session;
    }

    async updateGroupInvite(sessionId, userId, groupInviteLink) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            throw new Error('Sessão não encontrada');
        }

        const normalized = (groupInviteLink || '').trim() || null;
        await this.sessionRepository.setGroupInviteLink(sessionId, userId, normalized);
        // Atualiza a config em memória para valer na sessão em execução sem reiniciar.
        updateSessionConfig(sessionId, { groupInviteLink: normalized });

        return { ok: true, groupInviteLink: normalized };
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
