// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP Checksum Validator Unit Tests (Phase 192 Task 2)
 *
 * Fixture battery for the deterministic checksum tier of the document-scan
 * pipeline. All fixtures are probe-verified against the shipped validators:
 *  - Codice Fiscale: canonical RSSMRA85M01A001X + omocodia RSSMRAU5ML1A001X
 *    (decode-first normalization). NOTE: RSSMRA85M01A001R — the fixture
 *    carried by 192-RESEARCH.md — is asserted FALSE here: the research probe
 *    applied the ODD/EVEN tables with inverted parity; the official check
 *    letter for RSSMRA85M01A001 is X (corroborated by stdnum's own tables,
 *    the Wikipedia example VRNGNY07D68C351V, and codice-fiscale's
 *    MRTMTT25D09F205Z).
 *  - Partita IVA: 00743110157 valid / 00743110158 invalid (research A2 —
 *    only the verified fixture pair is trusted).
 *  - IBAN: mod-97 ISO 7064, Italian 27-char + generic ≥15 lengths.
 *
 * No DB, no env, no mocks — dlpChecksum.ts is a pure module.
 */
import "./helpers/setupEnv";
import {
  isValidCodiceFiscale,
  isValidIban,
  isValidPartitaIva,
  normalizeCodiceFiscale,
} from "../services/dlpChecksum";

describe("DLP Checksum — Codice Fiscale", () => {
  it("validates the canonical fixture RSSMRA85M01A001X", () => {
    expect(isValidCodiceFiscale("RSSMRA85M01A001X")).toBe(true);
  });

  it("validates the omocodia fixture RSSMRAU5ML1A001X after decode-first normalization (Pitfall 1 arbiter)", () => {
    expect(isValidCodiceFiscale("RSSMRAU5ML1A001X")).toBe(true);
  });

  it("normalizeCodiceFiscale decodes omocodia letters (0-based positions 6,7,9,10,12,13,14) to the canonical form", () => {
    expect(normalizeCodiceFiscale("RSSMRAU5ML1A001X")).toBe("RSSMRA85M01A001X");
  });

  it("normalizes case and embedded whitespace at the boundary", () => {
    expect(normalizeCodiceFiscale(" rssmra85m01a001x ")).toBe("RSSMRA85M01A001X");
    expect(isValidCodiceFiscale("rssmra85m01a001x")).toBe(true);
  });

  it("rejects the research probe fixture RSSMRA85M01A001R (inverted-parity artifact, official check letter is X)", () => {
    expect(isValidCodiceFiscale("RSSMRA85M01A001R")).toBe(false);
  });

  it("rejects a wrong check letter under official parity", () => {
    expect(isValidCodiceFiscale("VRNGNY07D68C351X")).toBe(false);
  });

  it("validates the independent Wikipedia fixture VRNGNY07D68C351V", () => {
    expect(isValidCodiceFiscale("VRNGNY07D68C351V")).toBe(true);
  });

  it("rejects malformed lengths with null from normalizeCodiceFiscale", () => {
    expect(normalizeCodiceFiscale("RSSMRA85M01A001")).toBeNull();
    expect(normalizeCodiceFiscale("RSSMRA85M01A001XX")).toBeNull();
    expect(normalizeCodiceFiscale("")).toBeNull();
    expect(isValidCodiceFiscale("RSSMRA85M01A001")).toBe(false);
  });
});

describe("DLP Checksum — Partita IVA", () => {
  it("validates the probe-verified fixture 00743110157", () => {
    expect(isValidPartitaIva("00743110157")).toBe(true);
  });

  it("rejects the one-digit-off fixture 00743110158", () => {
    expect(isValidPartitaIva("00743110158")).toBe(false);
  });

  it("rejects wrong lengths and non-digit input", () => {
    expect(isValidPartitaIva("0074311015")).toBe(false);
    expect(isValidPartitaIva("007431101577")).toBe(false);
    expect(isValidPartitaIva("0074311015A")).toBe(false);
  });
});

describe("DLP Checksum — IBAN (mod-97)", () => {
  it("validates a canonical Italian 27-char IBAN", () => {
    expect(isValidIban("IT60X0542811101000000123456")).toBe(true);
  });

  it("rejects a one-digit-off Italian IBAN (mod-97 fail)", () => {
    expect(isValidIban("IT60X0542811101000000123457")).toBe(false);
  });

  it("accepts spaced 4-char groups (legal in documents)", () => {
    expect(isValidIban("IT60 X054 2811 1010 0000 0123 456")).toBe(true);
  });

  it("accepts lowercase input", () => {
    expect(isValidIban("it60x0542811101000000123456")).toBe(true);
  });

  it("validates a generic non-Italian 22-char IBAN by mod-97", () => {
    expect(isValidIban("DE89370400440532013000")).toBe(true);
  });

  it("validates a minimum-length 15-char IBAN by mod-97", () => {
    expect(isValidIban("NO9386011117947")).toBe(true);
  });

  it("rejects strings shorter than 15 chars", () => {
    expect(isValidIban("IT60X05428111010")).toBe(false);
  });

  it("rejects a corrupted mod-97 on a generic IBAN", () => {
    expect(isValidIban("DE89370400440532013001")).toBe(false);
  });
});

describe("DLP Checksum — placeholder non-match guard (D-03 idempotency precondition)", () => {
  const PLACEHOLDERS = ["[PERSON_1]", "[ADDRESS_2]", "[FINANCIAL_3]", "[GOV_ID_2]", "[CONTACT_5]"];

  it.each(PLACEHOLDERS)("placeholder %s is rejected by ALL three validators", (token) => {
    expect(isValidCodiceFiscale(token)).toBe(false);
    expect(isValidPartitaIva(token)).toBe(false);
    expect(isValidIban(token)).toBe(false);
  });

  it.each(PLACEHOLDERS)("placeholder %s returns null from normalizeCodiceFiscale", (token) => {
    expect(normalizeCodiceFiscale(token)).toBeNull();
  });
});