import { startSession, stopSession, getQRCode, updateSessionConfig, deleteSession, getPendingMessages, cancelPendingMessage, sendPendingMessageNow, sendPromoMessage, sendNoticeMessage } from '../../manager.js';

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

    async deleteSession(identificador, userId) {
        // Compat de deploy: o id numérico é o caminho novo, o nome (slug) é o
        // fallback enquanto o front antigo estiver no ar em produção.
        // TODO: remover o fallback por nome quando o front só mandar id.
        // Efeito colateral aceito: uma margem chamada "12" seria lida como id.
        const rowId = Number(identificador);
        const porId =
            Number.isInteger(rowId) && String(rowId) === String(identificador);

        const rows = porId
            ? await this.sessionRepository.getSessionByRowId(rowId, userId)
            : await this.sessionRepository.getSessionById(identificador, userId);

        const session = rows?.[0];
        if (!session) {
            throw new Error('Sessão não encontrada');
        }

        // O manager é chaveado pelo NOME (Maps em memória e a pasta
        // sessions/<nome> em disco), por isso a linha é resolvida antes.
        if (session.status) {
            await stopSession(session.sessionId);
        }
        await deleteSession(session.sessionId);

        // Com a linha em mãos, o DELETE vai sempre pela PK — inequívoco mesmo
        // que existam duas margens com o mesmo nome (session_id não é UNIQUE).
        await this.sessionRepository.deleteSessionByRowId(session.id, userId);
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

    /**
     * Botões da Fila no painel: "Encerrar" (tira da fila sem enviar) e "Enviar
     * agora" (dispara já). Mesma checagem de posse do `sendPromo` — sem ela um
     * usuário logado mexeria na fila da margem de outro.
     */
    async cancelPendingMessage(sessionId, userId, msgId) {
        await this.#garantirMargemDoUsuario(sessionId, userId);
        return cancelPendingMessage(sessionId, msgId);
    }

    async sendPendingMessageNow(sessionId, userId, msgId) {
        await this.#garantirMargemDoUsuario(sessionId, userId);
        return sendPendingMessageNow(sessionId, msgId);
    }

    async #garantirMargemDoUsuario(sessionId, userId) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            const error = new Error('Sessão não encontrada');
            error.statusCode = 404;
            throw error;
        }
    }

    /**
     * Dispara uma promoção montada na tela "Criar promoção" nos grupos de
     * destino da margem. A checagem de posse é obrigatória: sem ela qualquer
     * usuário logado enviaria mensagem pela margem de outro.
     */
    async sendPromo(sessionId, userId, { imageBase64, caption }) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            const error = new Error('Sessão não encontrada');
            error.statusCode = 404;
            throw error;
        }

        return sendPromoMessage(sessionId, { imageBase64, caption });
    }

    /**
     * Dispara um aviso (convite de grupo) direto nos grupos de destino da margem.
     * A checagem de posse é a mesma do `sendPromo`: sem ela qualquer usuário
     * logado dispararia pela margem de outro.
     */
    async sendNotice(sessionId, userId, { message }) {
        const existsSession = await this.sessionRepository.getSessionById(sessionId, userId);
        if (!existsSession || existsSession.length === 0) {
            const error = new Error('Sessão não encontrada');
            error.statusCode = 404;
            throw error;
        }

        return sendNoticeMessage(sessionId, { message });
    }
}
