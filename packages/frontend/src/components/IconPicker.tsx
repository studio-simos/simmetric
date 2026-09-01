// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Briefcase,
  Building2,
  Cpu,
  FileText,
  FlaskConical,
  Globe,
  GraduationCap,
  HeartPulse,
  Home,
  Hospital,
  Landmark,
  Plane,
  Scale,
  Shield,
  ShoppingBag,
  Truck,
  Users,
  Zap,
  BookOpen,
  Factory,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Briefcase,
  Building2,
  Cpu,
  FileText,
  FlaskConical,
  Globe,
  GraduationCap,
  HeartPulse,
  Home,
  Hospital,
  Landmark,
  Plane,
  Scale,
  Shield,
  ShoppingBag,
  Truck,
  Users,
  Zap,
  BookOpen,
  Factory,
};

interface IconPickerProps {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}

export function IconPicker({ value, onChange, disabled }: IconPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const selectedName = ICON_MAP[value] ? value : "";
  const SelectedIcon = selectedName ? ICON_MAP[selectedName] : null;

  const term = search.trim().toLowerCase();
  const filtered = term
    ? Object.entries(ICON_MAP).filter(([name]) => name.toLowerCase().includes(term))
    : Object.entries(ICON_MAP);

  const handleSelect = (name: string) => {
    onChange(name);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="w-10 h-10 p-0"
          disabled={disabled}
          aria-label="Select icon"
        >
          {SelectedIcon ? (
            <SelectedIcon className="w-5 h-5" />
          ) : (
            <span className="text-sm">{value || "—"}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        <Input
          placeholder={t("common.searchIcons")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-3"
        />
        {filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-4">
            {t("common.noIconsFound")}
          </div>
        ) : (
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2 max-h-60 overflow-y-auto">
            {filtered.map(([name, Icon]) => {
              const isSelected = name === selectedName;
              return (
                <Button
                  key={name}
                  variant={isSelected ? "default" : "ghost"}
                  size="icon"
                  className={`min-w-[44px] min-h-[44px] ${
                    isSelected ? "bg-primary/10 border border-primary" : ""
                  }`}
                  onClick={() => handleSelect(name)}
                  title={name}
                >
                  <Icon className="w-4 h-4" />
                </Button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
