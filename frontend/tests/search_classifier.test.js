"use strict";

/**
 * classifyQuery() is pure JS with no DOM dependency, exported directly via
 * script.js's `module.exports` block (guarded by `typeof document ===
 * "undefined"`, so `elements` becomes `{}` and nothing here touches the
 * DOM) -- loaded with a plain `require`, no jsdom needed.
 *
 * Covers the rule table documented in CLAUDE.md's "Dual-mode search"
 * section, with extra attention to the two rules flagged there as
 * fragile: the `wordCount <= 3` guard on punctuation/camelCase checks, and
 * the >=7-character-word check for short concept phrases.
 */

const assert = require("assert");
const { classifyQuery } = require("../script.js");

describe("classifyQuery", () => {
  it("treats an empty query as semantic (no-op fallback)", () => {
    assert.strictEqual(classifyQuery(""), "semantic");
    assert.strictEqual(classifyQuery("   "), "semantic");
  });

  it("treats a query ending in '?' as semantic", () => {
    assert.strictEqual(classifyQuery("what does this do?"), "semantic");
  });

  it("treats a single token as keyword", () => {
    assert.strictEqual(classifyQuery("X_norm"), "keyword");
    assert.strictEqual(classifyQuery("dataframe"), "keyword");
  });

  it("treats a query starting with a Python keyword as keyword", () => {
    assert.strictEqual(classifyQuery("import pandas as pd"), "keyword");
    assert.strictEqual(classifyQuery("def train_model"), "keyword");
  });

  it("treats short code-punctuation queries as keyword (wordCount <= 3 guard)", () => {
    assert.strictEqual(classifyQuery("x = 3"), "keyword");
    assert.strictEqual(classifyQuery("df.dropna()"), "keyword");
  });

  it("treats short camelCase/snake_case queries as keyword", () => {
    assert.strictEqual(classifyQuery("X_norm value"), "keyword");
    assert.strictEqual(classifyQuery("getUserData"), "keyword");
  });

  it("does not misclassify a longer natural-language query containing '=' as keyword", () => {
    // Regression guard named directly in CLAUDE.md: longer descriptions
    // that happen to embed code notation should still read as semantic.
    const result = classifyQuery("x = 3 and two other assignments");
    assert.strictEqual(result, "semantic");
  });

  it("treats short concept-noun phrases as semantic via the >=7-char rule", () => {
    assert.strictEqual(classifyQuery("data normalization"), "semantic");
    assert.strictEqual(classifyQuery("variable assignment"), "semantic");
  });

  it("treats short queries with no code or long-word markers as keyword", () => {
    assert.strictEqual(classifyQuery("fit model"), "keyword");
    assert.strictEqual(classifyQuery("load csv"), "keyword");
  });

  it("treats longer queries with linking words as semantic", () => {
    assert.strictEqual(
      classifyQuery("normalize the data using the mean and std"),
      "semantic",
    );
  });

  it("treats explicit question/instruction verbs as semantic regardless of length", () => {
    assert.strictEqual(classifyQuery("explain X_norm"), "semantic");
    assert.strictEqual(classifyQuery("show me the plot"), "semantic");
  });
});
