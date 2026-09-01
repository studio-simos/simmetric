/**
 * Mock for @langchain/core — provides deterministic message types
 * without requiring the actual langchain runtime.
 */

module.exports = {
  HumanMessage: jest.fn().mockImplementation((content) => ({
    content,
    _getType: () => "human",
  })),
  AIMessage: jest.fn().mockImplementation((content) => ({
    content,
    _getType: () => "ai",
  })),
  SystemMessage: jest.fn().mockImplementation((content) => ({
    content,
    _getType: () => "system",
  })),
};