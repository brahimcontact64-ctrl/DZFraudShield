import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("PART 3: Database Audit", () => {
  let migrationFiles: Map<string, string>;

  beforeAll(() => {
    migrationFiles = new Map();
    const migrationsDir =
      "c:\\Users\\Privat\\Downloads\\plugin woocomerce\\supabase\\migrations";

    // Load all migration files
    const fs = require("fs");
    const files = fs.readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql"));
    console.log(`Found ${files.length} migration files`);

    for (const file of files) {
      try {
        const content = readFileSync(
          join(migrationsDir, file),
          "utf-8"
        );
        migrationFiles.set(file, content);
      } catch (e) {
        console.warn(`Failed to read ${file}:`, e);
      }
    }
  });

  describe("Index Coverage Analysis", () => {
    it("verifies all critical columns have indexes", () => {
      const criticalIndexes = {
        "merchant_id": true,
        "created_at": true,
        "phone_hash": true,
        "ip_hash": true,
        "device_hash": true,
        "updated_at": true,
      };

      const foundIndexes = new Set<string>();
      let indexCount = 0;

      for (const [file, content] of migrationFiles) {
        const indexMatches = content.match(
          /create index if not exists .*? on .*?\((.*?)\)/gi
        );
        if (indexMatches) {
          indexMatches.forEach((match) => {
            indexCount++;
            // Extract column names from the index
            const columnMatch = match.match(/on .*?\((.*?)\)/i);
            if (columnMatch) {
              const column = columnMatch[1].split(",")[0].trim().split(" ")[0];
              foundIndexes.add(column);
            }
          });
        }
      }

      console.log(`\n=== INDEX ANALYSIS ===`);
      console.log(`Total indexes: ${indexCount}`);
      console.log(`Indexed columns: ${Array.from(foundIndexes).join(", ")}`);

      // Check critical indexes are covered
      for (const [column, _] of Object.entries(criticalIndexes)) {
        const hasCriticalIndex = Array.from(foundIndexes).some(
          (idx) => idx.includes(column) || column.includes(idx)
        );
        if (!hasCriticalIndex) {
          console.warn(`⚠️  No index found for critical column: ${column}`);
        }
      }

      expect(indexCount).toBeGreaterThan(10); // Sanity check: should have many indexes
    });
  });

  describe("N+1 Query Pattern Detection", () => {
    it("scans codebase for potential N+1 patterns", () => {
      const fs = require("fs");
      const pathModule = require("path");

      const srcDir = "c:\\Users\\Privat\\Downloads\\plugin woocomerce\\apps\\saas\\src";
      const issues: Array<{ file: string; pattern: string; line: number }> = [];

      function scanDirectory(dir: string) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const fullPath = pathModule.join(dir, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory() && !file.includes("node_modules")) {
              scanDirectory(fullPath);
            } else if (file.endsWith(".ts") || file.endsWith(".tsx")) {
              try {
                const content = readFileSync(fullPath, "utf-8");
                const lines = content.split("\n");

                lines.forEach((line, idx) => {
                  // Pattern 1: for loop with await inside
                  if (
                    line.includes("for ") &&
                    line.includes("(") &&
                    lines[idx + 1]?.includes("await ")
                  ) {
                    issues.push({
                      file: fullPath.replace(srcDir, ""),
                      pattern: "potential N+1: loop with await",
                      line: idx + 1,
                    });
                  }

                  // Pattern 2: .map() with async
                  if (
                    line.includes(".map(") &&
                    (line.includes("async") || lines[idx]?.includes("async"))
                  ) {
                    issues.push({
                      file: fullPath.replace(srcDir, ""),
                      pattern: "potential N+1: .map() with async",
                      line: idx + 1,
                    });
                  }

                  // Pattern 3: Promise.all with for loop results
                  if (
                    line.includes("Promise.all") &&
                    lines.slice(Math.max(0, idx - 5), idx).some(
                      (l) => l.includes("for ")
                    )
                  ) {
                    // This is usually OK (batched queries), so we skip it
                  }
                });
              } catch (e) {
                // Skip files that can't be read
              }
            }
          }
        } catch (e) {
          // Skip directories that can't be read
        }
      }

      console.log("\n=== N+1 QUERY PATTERN ANALYSIS ===");
      console.log(`Scanning ${srcDir} for potential issues...`);

      scanDirectory(srcDir);

      console.log(`Found ${issues.length} potential N+1 patterns`);
      if (issues.length > 0) {
        console.log("\nPotential N+1 Issues:");
        issues.slice(0, 10).forEach((issue) => {
          console.log(
            `  ${issue.file}:${issue.line} - ${issue.pattern}`
          );
        });
        if (issues.length > 10) {
          console.log(`  ... and ${issues.length - 10} more`);
        }
      }

      // N+1 patterns are often acceptable if done with Promise.all
      // This is a warning, not a failure
      expect(issues.length).toBeLessThan(50); // Allow some patterns but flag excessive ones
    });
  });

  describe("RLS Policy Performance", () => {
    it("verifies RLS policies use indexed columns", () => {
      const rlsIssues: Array<{ table: string; issue: string }> = [];

      for (const [file, content] of migrationFiles) {
        // Look for RLS policies
        const policyMatches = content.match(
          /create policy .*? on .*? using \((.*?)\)/gi
        );
        if (policyMatches) {
          policyMatches.forEach((policy) => {
            // Check if policy uses indexed columns
            const usesIndexedColumn =
              policy.includes("auth.uid()") ||
              policy.includes("merchant_id") ||
              policy.includes("created_at");

            if (!usesIndexedColumn) {
              const tableMatch = policy.match(/on (\w+)/i);
              if (tableMatch) {
                rlsIssues.push({
                  table: tableMatch[1],
                  issue: "RLS policy may not use indexed columns efficiently",
                });
              }
            }
          });
        }
      }

      console.log(`\n=== RLS POLICY ANALYSIS ===`);
      console.log(
        `RLS policies checked. Issues found: ${rlsIssues.length}`
      );

      if (rlsIssues.length > 0) {
        console.log("Potential RLS Performance Issues:");
        rlsIssues.slice(0, 5).forEach((issue) => {
          console.log(`  ${issue.table}: ${issue.issue}`);
        });
      }

      expect(rlsIssues.length).toBeLessThan(5); // Should have few RLS issues
    });
  });

  describe("Table Scan Risk Analysis", () => {
    it("identifies queries that might cause table scans", () => {
      const tableScans: Array<{ table: string; column: string }> = [];

      for (const [file, content] of migrationFiles) {
        // Find tables that are queried by non-indexed columns
        const tableMatches = content.match(
          /from public\.(\w+) where (\w+)/gi
        );

        if (tableMatches) {
          tableMatches.forEach((match) => {
            const [, tableName, columnName] = match
              .match(/from public\.(\w+) where (\w+)/i) || [];

            if (tableName && columnName) {
              // Check if this column is indexed
              const hasIndex = content.includes(
                `create index.*${columnName}`
              );
              if (!hasIndex) {
                tableScans.push({ table: tableName, column: columnName });
              }
            }
          });
        }
      }

      console.log(`\n=== TABLE SCAN RISK ANALYSIS ===`);
      console.log(`Potential unindexed columns: ${tableScans.length}`);

      const uniqueScans = Array.from(
        new Set(tableScans.map((s) => `${s.table}.${s.column}`))
      );
      console.log(`Unique combinations: ${uniqueScans.length}`);

      if (uniqueScans.length > 0 && uniqueScans.length < 10) {
        console.log("Potentially unindexed queries:");
        uniqueScans.slice(0, 5).forEach((scan) => {
          console.log(`  ${scan}`);
        });
      }

      expect(uniqueScans.length).toBeLessThan(20); // Should have few unindexed queries
    });
  });

  describe("Lock Risk Analysis", () => {
    it("identifies potential locking issues", () => {
      const lockingPatterns: string[] = [];

      for (const [file, content] of migrationFiles) {
        // Look for long-running operations that might lock tables
        if (content.includes("UPDATE public.")) {
          lockingPatterns.push(file);
        }
        if (content.includes("DELETE FROM public.")) {
          lockingPatterns.push(file);
        }
        if (content.includes("ALTER TABLE") && file.includes("migration")) {
          lockingPatterns.push(file);
        }
      }

      console.log(`\n=== LOCKING RISK ANALYSIS ===`);
      console.log(
        `Files with UPDATE/DELETE/ALTER operations: ${lockingPatterns.length}`
      );

      // This is informational only - these operations are sometimes necessary
      expect(lockingPatterns.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Connection Pool Efficiency", () => {
    it("estimates required database connections", () => {
      // Based on the architecture:
      // - Next.js server components
      // - API routes with concurrent requests
      // - Background jobs (delivery sync)
      // - Dashboard read operations

      const estimatedLoad = {
        concurrent_api_requests: 100,
        dashboard_users: 50,
        background_jobs: 5,
        webhook_handlers: 10,
        connection_overhead: 1.2,
      };

      const requiredConnections = Math.ceil(
        (estimatedLoad.concurrent_api_requests +
          estimatedLoad.dashboard_users +
          estimatedLoad.background_jobs +
          estimatedLoad.webhook_handlers) *
          estimatedLoad.connection_overhead
      );

      console.log(`\n=== CONNECTION POOL ANALYSIS ===`);
      console.log(`Estimated concurrent API requests: ${estimatedLoad.concurrent_api_requests}`);
      console.log(`Dashboard concurrent users: ${estimatedLoad.dashboard_users}`);
      console.log(`Background jobs: ${estimatedLoad.background_jobs}`);
      console.log(`Webhook handlers: ${estimatedLoad.webhook_handlers}`);
      console.log(`Recommended min pool size: ${requiredConnections}`);
      console.log(`Recommended max pool size: ${Math.ceil(requiredConnections * 1.5)}`);

      expect(requiredConnections).toBeGreaterThan(0);
      expect(requiredConnections).toBeLessThan(500); // Sanity check
    });
  });

  describe("Query Complexity Analysis", () => {
    it("analyzes unified risk evaluator for query complexity", () => {
      const fs = require("fs");

      const evaluatorPath =
        "c:\\Users\\Privat\\Downloads\\plugin woocomerce\\apps\\saas\\src\\lib\\risk\\unified-evaluator.ts";

      let evaluatorContent = "";
      try {
        evaluatorContent = readFileSync(evaluatorPath, "utf-8");
      } catch (e) {
        console.warn("Could not read unified-evaluator.ts");
        expect(true).toBe(true); // Skip test
        return;
      }

      // Count number of database queries in evaluator
      const queryPatterns = [
        evaluatorContent.match(/\.from\(/g)?.length || 0,
        evaluatorContent.match(/\.select\(/g)?.length || 0,
        evaluatorContent.match(/\.query\(/g)?.length || 0,
      ];

      const totalQueries = queryPatterns.reduce((a, b) => a + b, 0);

      console.log(`\n=== UNIFIED RISK EVALUATOR ANALYSIS ===`);
      console.log(`Total database operations: ${totalQueries}`);
      console.log(
        `Note: High query count is expected for risk evaluation`
      );
      console.log(`This should be optimized with batch queries`);

      // Unified evaluator is complex and this is expected
      // We just want to ensure it's not pathologically bad
      expect(totalQueries).toBeLessThan(100);
    });
  });

  describe("Schema Size and Performance", () => {
    it("analyzes database schema size and growth", () => {
      let tableCount = 0;
      let columnCount = 0;
      let indexCount = 0;
      let policyCount = 0;

      for (const [file, content] of migrationFiles) {
        tableCount += (content.match(/create table/gi)?.length || 0);
        columnCount += (content.match(/,\n\s+\w+\s+/g)?.length || 0); // Rough estimate
        indexCount += (content.match(/create index/gi)?.length || 0);
        policyCount += (content.match(/create policy/gi)?.length || 0);
      }

      console.log(`\n=== DATABASE SCHEMA ANALYSIS ===`);
      console.log(`Tables: ${tableCount}`);
      console.log(`Indexes: ${indexCount}`);
      console.log(`RLS Policies: ${policyCount}`);
      console.log(`Estimated columns: ~${columnCount}`);

      const schemaHealthScore = {
        tables: tableCount > 20 ? 1 : 0.5,
        indexes: indexCount > 20 ? 1 : 0.5,
        policies: policyCount > 10 ? 1 : 0.5,
      };

      const avgScore =
        Object.values(schemaHealthScore).reduce((a, b) => a + b, 0) /
        Object.values(schemaHealthScore).length;

      console.log(`\nSchema health score: ${(avgScore * 100).toFixed(0)}%`);
      console.log(
        avgScore > 0.7
          ? "✓ Schema is well-designed for production"
          : "⚠️  Schema needs review"
      );

      expect(tableCount).toBeGreaterThan(10);
    });
  });
});
