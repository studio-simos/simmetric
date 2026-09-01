// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { useTranslation } from "react-i18next";
import { apiGet } from "../utils/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCategoryColor, GRAPH_COLORS } from "../utils/graphColors";

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  title: string;
  category: string;
  slug: string;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface ArchiveGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface ArchiveGraphViewProps {
  archiveId: string;
  onNodeClick?: (slug: string) => void;
}

export function ArchiveGraphView({ archiveId, onNodeClick }: ArchiveGraphViewProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<d3.Simulation<d3.SimulationNodeDatum, d3.SimulationLinkDatum<d3.SimulationNodeDatum>> | null>(null);
  const [graph, setGraph] = useState<ArchiveGraph>({ nodes: [], edges: [] });
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch graph data
  useEffect(() => {
    setLoading(true);
    apiGet<ArchiveGraph>(`/archives/${archiveId}/graph`)
      .then((data) => { setGraph(data); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [archiveId]);

  // D3 rendering
  useEffect(() => {
    if (!svgRef.current || graph.nodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const width = containerRef.current?.clientWidth || 800;
    const height = 600;

    const g = svg.append("g");

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform.toString());
      });
    svg.call(zoom);

    // Clone nodes and edges so D3 mutations do not affect React state.
    // D3 force simulation mutates data at runtime (adds x/y/vx/vy to nodes,
    // resolves source/target references on links). TypeScript can't track
    // these mutations, so we cast to the D3 simulation datum types here.
    const nodes = graph.nodes.map((n) => ({ ...n })) as d3.SimulationNodeDatum[];
    const edges = graph.edges.map((e) => ({ ...e }));

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink<d3.SimulationNodeDatum, d3.SimulationLinkDatum<d3.SimulationNodeDatum>>(edges)
          .id((d) => (d as GraphNode).id)
          .distance(100),
      )
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(30));

    simulationRef.current = simulation;

    // Links
    const link = g.append("g")
      .attr("stroke", GRAPH_COLORS.linkStroke)
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(edges)
      .join("line")
      .attr("stroke-width", GRAPH_COLORS.linkStrokeWidth);

    // Nodes
    // D3's forceSimulation generic leaks SimulationNodeDatum as the datum
    // type through selections, even when we explicitly bind GraphNode data.
    // We cast the entire node selection to keep callbacks type-safe without
    // sprinkling `as` casts on every accessor.
    const node = (g.append("g")
      .selectAll("g")
      .data(nodes)
      .join("g") as unknown as d3.Selection<SVGGElement, GraphNode, SVGGElement, unknown>)
      .style("cursor", onNodeClick ? "pointer" : "default")
      .call(
        d3
          .drag<SVGGElement, GraphNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x; d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          }),
      )

    node.append("circle")
      .attr("r", (d: GraphNode) => {
        const lowerSearch = search.toLowerCase();
        const isMatch = lowerSearch && (d.title.toLowerCase().includes(lowerSearch) || d.slug.toLowerCase().includes(lowerSearch));
        return isMatch ? 28 : 20;
      })
      .attr("fill", (d: GraphNode) => getCategoryColor(d.category))
      .attr("stroke", GRAPH_COLORS.nodeStroke)
      .attr("stroke-width", GRAPH_COLORS.nodeStrokeWidth);

    node.append("text")
      .attr("dy", (d: GraphNode) => {
        const lowerSearch = search.toLowerCase();
        const isMatch = lowerSearch && (d.title.toLowerCase().includes(lowerSearch) || d.slug.toLowerCase().includes(lowerSearch));
        return isMatch ? 42 : 35;
      })
      .attr("text-anchor", "middle")
      .text((d: GraphNode) => d.title)
      .attr("fill", GRAPH_COLORS.labelColor)
      .attr("font-size", (d: GraphNode) => {
        const lowerSearch = search.toLowerCase();
        const isMatch = lowerSearch && (d.title.toLowerCase().includes(lowerSearch) || d.slug.toLowerCase().includes(lowerSearch));
        return isMatch ? "14px" : "12px";
      })
      .attr("font-weight", (d: GraphNode) => {
        const lowerSearch = search.toLowerCase();
        const isMatch = lowerSearch && (d.title.toLowerCase().includes(lowerSearch) || d.slug.toLowerCase().includes(lowerSearch));
        return isMatch ? "700" : "500";
      });

    // Search highlighting — emphasize matched nodes, dim non-matched
    const lowerSearch = search.toLowerCase();
    const isMatchFn = (d: GraphNode) =>
      lowerSearch && (d.title.toLowerCase().includes(lowerSearch) || d.slug.toLowerCase().includes(lowerSearch));

    node.selectAll<SVGCircleElement, GraphNode>("circle")
      .attr("stroke", (d) => isMatchFn(d) ? GRAPH_COLORS.highlightColor : GRAPH_COLORS.nodeStroke)
      .attr("stroke-width", (d) => isMatchFn(d) ? 4 : GRAPH_COLORS.nodeStrokeWidth)
      .attr("opacity", (d) => {
        if (!lowerSearch) return 1;
        return isMatchFn(d) ? 1 : 0.25;
      });

    node.selectAll<SVGTextElement, GraphNode>("text")
      .attr("opacity", (d) => {
        if (!lowerSearch) return 1;
        return isMatchFn(d) ? 1 : 0.2;
      });

    // Dim edges that don't connect to any matched node
    link
      .attr("stroke-opacity", (d: d3.SimulationLinkDatum<d3.SimulationNodeDatum>) => {
        if (!lowerSearch) return 0.6;
        const src = d.source as d3.SimulationNodeDatum as unknown as GraphNode;
        const tgt = d.target as d3.SimulationNodeDatum as unknown as GraphNode;
        return (isMatchFn(src) || isMatchFn(tgt)) ? 0.8 : 0.08;
      })
      .attr("stroke", (d: d3.SimulationLinkDatum<d3.SimulationNodeDatum>) => {
        if (!lowerSearch) return GRAPH_COLORS.linkStroke;
        const src = d.source as d3.SimulationNodeDatum as unknown as GraphNode;
        const tgt = d.target as d3.SimulationNodeDatum as unknown as GraphNode;
        return (isMatchFn(src) || isMatchFn(tgt)) ? GRAPH_COLORS.highlightColor : GRAPH_COLORS.linkStroke;
      })
      .attr("stroke-width", (d: d3.SimulationLinkDatum<d3.SimulationNodeDatum>) => {
        if (!lowerSearch) return GRAPH_COLORS.linkStrokeWidth;
        const src = d.source as d3.SimulationNodeDatum as unknown as GraphNode;
        const tgt = d.target as d3.SimulationNodeDatum as unknown as GraphNode;
        return (isMatchFn(src) || isMatchFn(tgt)) ? 3 : GRAPH_COLORS.linkStrokeWidth;
      });

    // Auto-zoom to fit matched nodes when search is active
    if (lowerSearch) {
      const matchedNodes = nodes.filter((n) => {
        const gn = n as unknown as GraphNode;
        return gn.title.toLowerCase().includes(lowerSearch) || gn.slug.toLowerCase().includes(lowerSearch);
      });
      if (matchedNodes.length > 0 && svgRef.current) {
        const xs = matchedNodes.map((n) => n.x ?? 0);
        const ys = matchedNodes.map((n) => n.y ?? 0);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const pad = 80;
        const dx = maxX - minX, dy = maxY - minY;
        if (dx > 0 || dy > 0 || matchedNodes.length === 1) {
          const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
          const scale = Math.min(
            width / (Math.max(dx, 100) + pad * 2),
            height / (Math.max(dy, 100) + pad * 2),
            3,
          );
          const tx = width / 2 - scale * cx;
          const ty = height / 2 - scale * cy;
          const svgEl = d3.select(svgRef.current);
          svgEl.transition().duration(500).call(
            d3.zoom<SVGSVGElement, unknown>().transform,
            d3.zoomIdentity.translate(tx, ty).scale(scale),
          );
        }
      }
    }

    // Click handler
    if (onNodeClick) {
      node.on("click", (_event, d) => {
        onNodeClick(d.slug);
      });
    }

    simulation.on("tick", () => {
      // D3 mutates source/target to be full node objects during simulation.
      // TypeScript sees them as string | SimulationNodeDatum, so we assert
      // the post-resolution shape.
      link.attr("x1", (d: d3.SimulationLinkDatum<d3.SimulationNodeDatum>) =>
        (d.source as d3.SimulationNodeDatum).x ?? 0,
      );
      link.attr("y1", (d: d3.SimulationLinkDatum<d3.SimulationNodeDatum>) =>
        (d.source as d3.SimulationNodeDatum).y ?? 0,
      );
      link.attr("x2", (d: d3.SimulationLinkDatum<d3.SimulationNodeDatum>) =>
        (d.target as d3.SimulationNodeDatum).x ?? 0,
      );
      link.attr("y2", (d: d3.SimulationLinkDatum<d3.SimulationNodeDatum>) =>
        (d.target as d3.SimulationNodeDatum).y ?? 0,
      );
      node.attr("transform", (d: GraphNode) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => {
      simulation.stop();
    };
  }, [graph, search, onNodeClick]);

  const handleResetZoom = () => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.transition().duration(750).call(
      d3.zoom<SVGSVGElement, unknown>().transform,
      d3.zoomIdentity,
    );
  };

  if (loading) return <div className="p-6 text-muted-foreground">{t("graph.loading")}</div>;
  if (error) return <div className="p-6 text-red-500">{t("graph.error")}: {error}</div>;
  if (graph.nodes.length === 0) return <div className="p-6 text-muted-foreground">{t("graph.noPages")}</div>;

  return (
    <div ref={containerRef} className="w-full h-[600px] flex flex-col">
      <div className="flex items-center gap-3 mb-3">
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("graph.searchPlaceholder")}
          className="flex-1 text-sm"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetZoom}
        >
          {t("graph.resetZoom")}
        </Button>
      </div>
      <svg ref={svgRef} className="w-full h-full border border-border rounded-lg bg-card" />
    </div>
  );
}
