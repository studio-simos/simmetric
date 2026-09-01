/**
 * Mock for langchain — provides deterministic ChatOllama
 * without requiring a running Ollama instance.
 */

module.exports = {
  ChatOllama: jest.fn().mockImplementation(() => ({
    invoke: jest.fn().mockResolvedValue({ content: "mocked llm response" }),
    stream: jest.fn().mockReturnValue(
      (async function* () {
        yield { content: "mock" };
      })()
    ),
  })),
};