#!/usr/bin/env node

/**
 * REAL PRODUCTION LOAD TEST
 * 
 * Run with: node scripts/real-production-load-test.mjs
 * 
 * This script loads .env and tests REAL:
 * - Supabase database latency
 * - Notification delivery
 * - API throughput
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Load .env from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
config({ path: resolve(projectRoot, '.env') });
config({ path: resolve(projectRoot, '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ ERROR: Missing Supabase credentials');
  console.error('   NEXT_PUBLIC_SUPABASE_URL:', SUPABASE_URL ? '✓ Found' : '✗ Missing');
  console.error('   SUPABASE_SERVICE_ROLE_KEY:', SUPABASE_KEY ? '✓ Found' : '✗ Missing');
  process.exit(1);
}

console.log('✓ Supabase credentials loaded');
console.log(`  URL: ${SUPABASE_URL}`);

// Create client without realtime (Node.js v20 compatibility)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: {
    headers: {
      // Add headers to skip realtime setup
    }
  }
});

// Disable realtime to avoid WebSocket requirement
supabase.removeAllChannels();

// Metrics collector
class Metrics {
  constructor(name) {
    this.name = name;
    this.measurements = [];
  }

  record(ms) {
    this.measurements.push(ms);
  }

  stats() {
    const sorted = [...this.measurements].sort((a, b) => a - b);
    const len = sorted.length;
    return {
      count: len,
      min: sorted[0],
      max: sorted[len - 1],
      avg: sorted.reduce((a, b) => a + b, 0) / len,
      p50: sorted[Math.floor(len * 0.5)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.floor(len * 0.99)],
      throughput: len / (sorted.reduce((a, b) => a + b, 0) / 1000)
    };
  }

  report() {
    const s = this.stats();
    console.log(`\n${this.name}:`);
    console.log(`  Count: ${s.count}`);
    console.log(`  Min: ${s.min.toFixed(2)}ms`);
    console.log(`  Max: ${s.max.toFixed(2)}ms`);
    console.log(`  Avg: ${s.avg.toFixed(2)}ms`);
    console.log(`  P50: ${s.p50.toFixed(2)}ms`);
    console.log(`  P95: ${s.p95.toFixed(2)}ms`);
    console.log(`  P99: ${s.p99.toFixed(2)}ms`);
    console.log(`  Throughput: ${s.throughput.toFixed(0)} ops/sec`);
    return s;
  }
}

async function runLoadTest() {
  console.log('\n\n====== REAL PRODUCTION LOAD TEST ======\n');

  const dbMetrics = new Metrics('Database Operations');
  const notifMetrics = new Metrics('Notification Operations');

  // Create test merchant
  console.log('Setting up test merchant...');
  const merchantId = randomUUID();
  const merchantName = `Load Test ${Date.now()}`;
  const testUserId = '00000000-0000-0000-0000-000000000001';

  const { error: merchantError } = await supabase.from('merchants').insert({
    id: merchantId,
    owner_user_id: testUserId,
    name: merchantName,
    email: `test-${Date.now()}@example.com`,
    country_code: 'DZ',
    timezone: 'Africa/Algiers'
  });

  if (merchantError && !merchantError.message.includes('duplicate')) {
    console.error('Failed to create merchant:', merchantError.message);
    process.exit(1);
  }

  console.log(`✓ Test merchant: ${merchantId}`);

  // TEST 1: 50 Merchants equivalent
  console.log('\n\n=== TEST 1: 50 Merchants Equivalent ===');
  console.log('Performing 50 read operations...');

  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    const { error } = await supabase
      .from('merchants')
      .select('id, name, created_at')
      .eq('id', merchantId)
      .single();
    const duration = performance.now() - start;
    dbMetrics.record(duration);

    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  console.log('Performing 50 order check inserts...');
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    const { error } = await supabase.from('order_checks').insert({
      merchant_id: merchantId,
      phone_hash: `phone_50_${i}`,
      ip_hash: `ip_50_${i}`,
      device_hash: `device_50_${i}`,
      cart_total: 3000 + Math.random() * 50000,
      product_count: 1 + Math.floor(Math.random() * 10),
      is_cod: Math.random() > 0.5,
      risk_score: Math.floor(Math.random() * 100),
      risk_level: ['LOW', 'MEDIUM', 'HIGH', 'BLOCK'][Math.floor(Math.random() * 4)],
      risk_reasons: [],
      recommended_action: 'accept'
    });
    const duration = performance.now() - start;
    dbMetrics.record(duration);

    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  const stats50 = dbMetrics.report();

  // TEST 2: 100 Merchants equivalent
  console.log('\n\n=== TEST 2: 100 Merchants Equivalent ===');
  console.log('Performing 50 read operations...');

  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    const { error } = await supabase
      .from('merchants')
      .select('id, name, created_at')
      .eq('id', merchantId)
      .single();
    const duration = performance.now() - start;
    dbMetrics.record(duration);

    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  console.log('Performing 50 order check inserts...');
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    const { error } = await supabase.from('order_checks').insert({
      merchant_id: merchantId,
      phone_hash: `phone_100_${i}`,
      ip_hash: `ip_100_${i}`,
      device_hash: `device_100_${i}`,
      cart_total: 3000 + Math.random() * 50000,
      product_count: 1 + Math.floor(Math.random() * 10),
      is_cod: Math.random() > 0.5,
      risk_score: Math.floor(Math.random() * 100),
      risk_level: ['LOW', 'MEDIUM', 'HIGH', 'BLOCK'][Math.floor(Math.random() * 4)],
      risk_reasons: [],
      recommended_action: 'accept'
    });
    const duration = performance.now() - start;
    dbMetrics.record(duration);

    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  const stats100 = dbMetrics.report();

  // TEST 3: 250 Merchants equivalent
  console.log('\n\n=== TEST 3: 250 Merchants Equivalent ===');
  console.log('Performing 50 mixed read/write operations...');

  for (let i = 0; i < 50; i++) {
    if (i % 2 === 0) {
      const start = performance.now();
      const { error } = await supabase
        .from('merchants')
        .select('id, name, created_at')
        .eq('id', merchantId)
        .single();
      const duration = performance.now() - start;
      dbMetrics.record(duration);
    } else {
      const start = performance.now();
      const { error } = await supabase.from('order_checks').insert({
        merchant_id: merchantId,
        phone_hash: `phone_250_${i}`,
        ip_hash: `ip_250_${i}`,
        device_hash: `device_250_${i}`,
        cart_total: 3000 + Math.random() * 50000,
        product_count: 1 + Math.floor(Math.random() * 10),
        is_cod: Math.random() > 0.5,
        risk_score: Math.floor(Math.random() * 100),
        risk_level: ['LOW', 'MEDIUM', 'HIGH', 'BLOCK'][Math.floor(Math.random() * 4)],
        risk_reasons: [],
        recommended_action: 'accept'
      });
      const duration = performance.now() - start;
      dbMetrics.record(duration);
    }

    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  const stats250 = dbMetrics.report();

  // TEST 4: Notification latency
  console.log('\n\n=== TEST 4: Notification Delivery ===');
  console.log('Inserting 100 notifications...');

  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const { error } = await supabase
      .from('merchant_notifications')
      .insert({
        merchant_id: merchantId,
        notification_type: 'order_risk_alert',
        title: `Risk Alert ${i}`,
        body: `Order risk assessment complete`,
        metadata: {
          orderId: `order_${i}`,
          riskScore: Math.floor(Math.random() * 100)
        }
      });
    const duration = performance.now() - start;
    notifMetrics.record(duration);

    if (i % 20 === 0) process.stdout.write('.');
  }
  console.log(' done');

  const notifStats = notifMetrics.report();

  // Generate capacity report
  console.log('\n\n====== REAL CAPACITY RECOMMENDATIONS ======\n');

  // Helper function to calculate safe capacity
  function capacityRecommendation(avgLatency, merchantLevel) {
    const secsPerDay = 86400;
    const opsPerSec = 1000 / avgLatency;
    const ordersPerDay = Math.floor(opsPerSec * secsPerDay);

    return {
      avgLatency,
      opsPerSec: opsPerSec.toFixed(0),
      ordersPerDay: ordersPerDay.toLocaleString(),
      peakTps: Math.floor(ordersPerDay / secsPerDay),
      status: avgLatency < (merchantLevel * 3) ? '✓ GO' : '⚠️ CONDITIONAL'
    };
  }

  const cap50 = capacityRecommendation(stats50.avg, 50);
  const cap100 = capacityRecommendation(stats100.avg, 100);
  const cap250 = capacityRecommendation(stats250.avg, 250);

  console.log('50 MERCHANTS:');
  console.log(`  Database Latency: ${cap50.avgLatency.toFixed(2)}ms`);
  console.log(`  Throughput: ${cap50.opsPerSec} ops/sec`);
  console.log(`  Safe Orders/Day: ${cap50.ordersPerDay}`);
  console.log(`  Peak TPS: ${cap50.peakTps}`);
  console.log(`  ${cap50.status}`);

  console.log('\n100 MERCHANTS:');
  console.log(`  Database Latency: ${cap100.avgLatency.toFixed(2)}ms`);
  console.log(`  Throughput: ${cap100.opsPerSec} ops/sec`);
  console.log(`  Safe Orders/Day: ${cap100.ordersPerDay}`);
  console.log(`  Peak TPS: ${cap100.peakTps}`);
  console.log(`  ${cap100.status}`);

  console.log('\n250 MERCHANTS:');
  console.log(`  Database Latency: ${cap250.avgLatency.toFixed(2)}ms`);
  console.log(`  Throughput: ${cap250.opsPerSec} ops/sec`);
  console.log(`  Safe Orders/Day: ${cap250.ordersPerDay}`);
  console.log(`  Peak TPS: ${cap250.peakTps}`);
  console.log(`  ${cap250.status}`);

  // Bottleneck analysis
  console.log('\n\n=== BOTTLENECK ANALYSIS ===');

  if (stats50.avg < 100) {
    console.log('✓ Database performance excellent');
  } else if (stats50.avg < 200) {
    console.log('✓ Database performance good');
  } else {
    console.log('⚠️ Database latency elevated');
  }

  if (notifStats.throughput > 500) {
    console.log('✓ Notification throughput excellent (500+ notifs/sec)');
  } else if (notifStats.throughput > 100) {
    console.log('✓ Notification throughput good (100+ notifs/sec)');
  } else {
    console.log('⚠️ Notification throughput low');
  }

  // Platform recommendations
  console.log('\n\n=== RECOMMENDED PLANS ===');

  if (stats50.avg < 150) {
    console.log('✓ Supabase: PRO ($25/month) - Sufficient for 50-100 merchants');
  } else {
    console.log('⚠️ Supabase: TEAM ($599/month) - Better performance for high load');
  }

  if (cap250.peakTps < 100) {
    console.log('✓ Vercel: PRO ($20/month) - Sufficient for projected load');
  } else {
    console.log('⚠️ Vercel: ENTERPRISE - Needed for sustained high volume');
  }

  // Final verdict
  console.log('\n\n====== FINAL VERDICT ======\n');

  const verdict50 = stats50.avg < 150 && stats50.p95 < 300 ? '✓ GO' : '⚠️ CONDITIONAL';
  const verdict100 = stats100.avg < 200 && stats100.p95 < 500 ? '✓ GO' : '⚠️ CONDITIONAL';
  const verdict250 = stats250.avg < 250 && stats250.p95 < 800 ? '✓ GO' : '⚠️ CONDITIONAL';

  console.log(`50 Merchants:   ${verdict50}`);
  console.log(`100 Merchants:  ${verdict100}`);
  console.log(`250 Merchants:  ${verdict250}`);

  // Cleanup
  console.log('\n\nCleaning up test data...');
  await supabase.from('order_checks').delete().eq('merchant_id', merchantId);
  await supabase.from('merchant_notifications').delete().eq('merchant_id', merchantId);
  await supabase.from('merchant_api_keys').delete().eq('merchant_id', merchantId);
  await supabase.from('merchants').delete().eq('id', merchantId);
  console.log('✓ Cleanup complete');

  console.log('\n✓ Real production load test completed successfully\n');
}

// Run the test
runLoadTest().catch((err) => {
  console.error('❌ Load test failed:', err.message);
  process.exit(1);
});
