// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { logger } from "@/utils/logger";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import WidgetAnalyticsTab from "./WidgetAnalyticsTab";

const COLORS = ["#4c6ef5", "#37b24d", "#f59f00", "#e03131", "#7048e8", "#1098ad"];

type AnalyticsTab = "system" | "widgets";

interface DailyUsage {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  count: number;
}

interface ModelUsage {
  model: string;
  modelDisplayName?: string | null;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  count: number;
}

interface TopUser {
  userId: string;
  username: string;
  email: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  count: number;
}

export default function AnalyticsPanel() {
  const { t } = useTranslation();
  usePageMeta(t("analytics.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.analytics") }]);

  return <AnalyticsPanelContent />;
}

// Extracted so every useState/useEffect is unconditional at the top level.
// AnalyticsPanel keeps useTranslation/usePageMeta in the wrapper so
// AnalyticsPanelContent can stay a plain presentational component; the gated
// UI state lives here where no conditional return precedes it.
function AnalyticsPanelContent() {
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<AnalyticsTab>("system");
  const [dailyData, setDailyData] = useState<DailyUsage[]>([]);
  const [modelData, setModelData] = useState<ModelUsage[]>([]);
  const [topUsers, setTopUsers] = useState<TopUser[]>([]);
  const [loading, setLoading] = useState(true);

  // Map API modelDisplayName to a displayName field for recharts labels/tooltips
  const displayModelData = modelData.map((entry) => ({
    ...entry,
    displayName: entry.modelDisplayName || entry.model,
  }));

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("token");
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      const [tokensRes, modelsRes, usersRes] = await Promise.all([
        fetch("/api/system/analytics/tokens?days=30", { headers }),
        fetch("/api/system/analytics/models", { headers }),
        fetch("/api/system/analytics/top-users?limit=10", { headers }),
      ]);

      if (tokensRes.ok) setDailyData(await tokensRes.json());
      if (modelsRes.ok) setModelData(await modelsRes.json());
      if (usersRes.ok) setTopUsers(await usersRes.json());
    } catch (err) {
      logger.error("[analytics] Failed to fetch analytics", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full overflow-y-auto p-6 space-y-8">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-[300px] w-full" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8">
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as AnalyticsTab)}>
        <TabsList>
          <TabsTrigger value="system">{t("analytics.title")}</TabsTrigger>
          <TabsTrigger value="widgets">{t("analytics.widgetAnalytics")}</TabsTrigger>
        </TabsList>

        <TabsContent value="system">
          {dailyData.length === 0 && modelData.length === 0 ? (
            <div className="text-secondary-foreground text-center">{t("analytics.noData")}</div>
          ) : (
            <div className="space-y-8">
              <h2 className="text-xl font-bold">{t("analytics.title")}</h2>

              {/* Daily Token Usage — Line Chart */}
              <Card>
                <CardHeader>
                  <CardTitle>{t("analytics.dailyTokens")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={dailyData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="promptTokens"
                        stroke="#4c6ef5"
                        name="Prompt"
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="completionTokens"
                        stroke="#37b24d"
                        name="Completion"
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="totalTokens"
                        stroke="#f59f00"
                        name="Total"
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Model Breakdown — Pie Chart */}
              <Card>
                <CardHeader>
                  <CardTitle>{t("analytics.modelBreakdown")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={displayModelData}
                        dataKey="totalTokens"
                        nameKey="displayName"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ""} (${((percent ?? 0) * 100).toFixed(0)}%)`}
                      >
                        {displayModelData.map((_entry, index) => (
                          <Cell key={index} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Top Users Table */}
              <Card>
                <CardHeader>
                  <CardTitle>{t("analytics.topUsers")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="px-4 py-2">{t("analytics.tableUser")}</TableHead>
                          <TableHead className="px-4 py-2 text-right">{t("analytics.tableTotalTokens")}</TableHead>
                          <TableHead className="px-4 py-2 text-right">{t("analytics.tableRequests")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {topUsers.map((user) => (
                          <TableRow key={user.userId} className="border-b border-border">
                            <TableCell className="px-4 py-2">
                              <div className="font-medium">{user.username}</div>
                              <div className="text-xs text-secondary-foreground">{user.email}</div>
                            </TableCell>
                            <TableCell className="px-4 py-2 text-right font-mono">
                              {user.totalTokens.toLocaleString()}
                            </TableCell>
                            <TableCell className="px-4 py-2 text-right font-mono">{user.count}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="widgets">
          <WidgetAnalyticsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
