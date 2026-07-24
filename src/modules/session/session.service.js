import { startSession, stopSession, getQRCode, updateSessionConfig, deleteSession, getPendingMessages } from '../../manager.js';

export default class SessionService {
    constructor(sessionRepository, mlCredentialService) {
        this.sessionRepository = sessionRepository;
        this.mlCredentialService = mlCredentialService;
    }

    // Garante que a margem só pode converter link se o dono for premium e já tiver
    // credenciais do Mercado Livre (tag + cookie). Sem isso, uma margem "convertendo"
    // descartaria todas as mensagens. Lança 403 (não premium) ou 400 (sem credenciais).
    async #assertCanConvert(userId) {
        // getCredentials já lança 403 quando o usuário não é premium.
        const cred = await this.mlCredentialService.getCredentials(userId);
        if (!cred.mlAffiliateTag || !cred.cookieString) {
            const error = new Error(
                "Configure suas credenciais do Mercado Livre antes de ativar a conversão de link"
            );
            error.statusCode = 400;
            throw error;
        }
    }

    async createSession(userId, sessionId, sourceGroupPrefix, targetGroupPrefix, folderId = null, convertLink = false) {
        if (convertLink) {
            await this.#assertCanConvert(userId);
        }

        // Configura os prefixos e o modo de conversão ANTES de iniciar a sessão
        updateSessionConfig(sessionId, {
            ...(sourceGroupPrefix && targetGroupPrefix
                ? { sourceGroupPrefix, targetGroupPrefix }
                : {}),
            convertLink
        });
        if (sourceGroupPrefix && targetGroupPrefix) {
            console.log(`✅ Prefixos configurados para ${sessionId}:`);
            console.log(`   📤 Origem: "${sourceGroupPrefix}"`);
            console.log(`   📥 Destino: "${targetGroupPrefix}"`);
        }
        console.log(`   🔗 Converte link do Mercado Livre: ${convertLink ? "sim" : "não"}`);

        await startSession(sessionId);

        const session = await this.sessionRepository.createSession(
            userId,
            sessionId,
            sourceGroupPrefix,
            targetGroupPrefix,
            folderId,
            convertLink
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
