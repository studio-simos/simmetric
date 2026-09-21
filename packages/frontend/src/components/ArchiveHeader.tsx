// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Plus, Trash2, Download, Menu } from "lucide-react";
import { Button } from "./ui/button";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "./ui/breadcrumb";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./ui/card";
import type { Archive } from "../queries/useArchives";

interface Props {
  archive: Archive;
  onNewPage: () => void;
  onExport: () => void;
  onDelete: () => void;
  onMenuClick?: () => void;
}

export default function ArchiveHeader({ archive, onNewPage, onExport, onDelete, onMenuClick }: Props) {
  const { t } = useTranslation();

  return (
    <div className="px-3 sm:px-6 pt-4">
      <div className="flex items-center gap-2">
        {/* Mobile hamburger menu for archive sidebar */}
        {onMenuClick && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onMenuClick}
            className="md:hidden shrink-0 -ml-1"
            aria-label={t("archives.openSidebar", "Open page list")}
            title={t("archives.openSidebar", "Open page list")}
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}
        <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/">{t("breadcrumb.home")}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/archives">{t("breadcrumb.archives")}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{archive.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      </div>

      <Card className="mt-4">
        <CardHeader className="flex flex-col sm:flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-2xl sm:text-[28px] font-semibold leading-[1.2]">{archive.name}</CardTitle>
            {archive.description && (
              <CardDescription>{archive.description}</CardDescription>
            )}
            <CardDescription>
              Created {new Date(archive.createdAt).toLocaleDateString()} by{" "}
              {archive.creator?.username ?? archive.createdBy}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            <Button onClick={onNewPage} size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              {t("archives.newPage")}
            </Button>
            <Button variant="outline" size="sm" onClick={onExport} title={t("export.buttonLabel")}>
              <Download className="mr-1.5 h-4 w-4" />
              {t("export.buttonLabel")}
            </Button>
            <Button variant="destructive" size="icon" onClick={onDelete} title={t("archives.deleteArchive")}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
