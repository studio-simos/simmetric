// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { memo } from "react";

interface HighlightedNameProps {
  name: string;
  query: string;
}

export const HighlightedName = memo(function HighlightedName({ name, query }: HighlightedNameProps) {
  if (!query) return <>{name}</>;
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerName.indexOf(lowerQuery);
  if (index === -1) return <>{name}</>;

  const before = name.slice(0, index);
  const match = name.slice(index, index + query.length);
  const after = name.slice(index + query.length);

  return (
    <>
      {before}
      <span className="bg-primary/50/15 text-foreground">{match}</span>
      {after}
    </>
  );
});