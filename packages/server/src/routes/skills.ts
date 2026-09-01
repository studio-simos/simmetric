// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { getAllBuiltinSkills } from "../agent/skills";
import "../agent/builtinSkills"; // Ensure skills are registered

const router = Router();
router.use(authMiddleware);

// GET /api/agent/skills — list all available skills
router.get("/skills", (_req: Request, res: Response) => {
  const skills = getAllBuiltinSkills().map((s) => ({
    name: s.name,
    displayName: s.displayName,
    description: s.description,
    type: s.type,
  }));
  res.json(skills);
});

export default router;
