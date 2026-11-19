// ======================================================
// APAGAR OS DADOS DE UMA CONVERSA (npm run forget -- <conversationId>)
// ======================================================
// Pedido de exclusão (LGPD): chama forget_conversation($1) no banco e imprime
// só "ok". O ID da conversa não vai para arquivo nem para o log; só aparece
// no histórico do seu terminal, porque você o digitou.

const { isValidConversationId } = require("../lib/session");

async function forgetConversation({ query, conversationId }) {
  if (!isValidConversationId(conversationId)) {
    const error = new Error("ID de conversa inválido");
    error.code = "INVALID_ID";
    throw error;
  }
  await query("select forget_conversation($1)", [conversationId]);
}

async function main() {
  require("dotenv").config();
  const db = require("../lib/db");
  const conversationId = (process.argv[2] || "").trim();

  if (!conversationId) {
    console.error("Uso: npm run forget -- <conversationId>");
    process.exitCode = 1;
    return;
  }
  if (!db.getPool()) {
    console.error("DATABASE_URL não definida: nada a fazer.");
    process.exitCode = 1;
    return;
  }

  try {
    await forgetConversation({ query: db.query, conversationId });
    console.log("ok");
  } catch (error) {
    // Só o código: a mensagem do banco pode repetir o ID
    console.error(`Falha: ${error.code || error.name || "erro"}`);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { forgetConversation };
