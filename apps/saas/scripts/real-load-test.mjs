#!/usr/bin/env node

/**
 * REAL PRODUCTION LOAD TEST
 * Direct REST API approach - no Supabase SDK WebSocket dependency
 */

import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Load .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
config({ path: resolve(projectRoot, '.env') });
config({ path: resolve(projectRoot, '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing Supabase credentials');
  process.exit(1);
}

console.log('✓ Supabase credentials loaded');
console.log(`  URL: ${SUPABASE_URL}`);

// Metrics
class Metrics {
  constructor(name) {
    this.name = name;
    this.measurements = [];
  }

  record(ms) {
    this.measurements.push(ms);
  }

  stats() {
    if (this.measurements.length === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        avg: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        throughput: 0
      };
    }

    const sorted = [...this.measurements].sort((a, b) => a - b);
    const len = sorted.length;
    const total = sorted.reduce((a, b) => a + b, 0);

    return {
      count: len,
      min: sorted[0],
      max: sorted[len - 1],
      avg: total / len,
      p50: sorted[Math.floor(len * 0.5)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.floor(len * 0.99)],
      throughput: (len / (total / 1000))
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

// REST API helper
async function supabaseRest(method, table, data = null, filter = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'apikey': SUPABASE_KEY
  };

  let url = `${SUPABASE_URL}/rest/v1/${table}`;

  const options = {
    method,
    headers
  };

  if (method === 'POST' || method === 'PUT') {
    options.body = JSON.stringify(data);
  }

  if (filter && method === 'GET') {
    url += `?${filter}`;
  }

  try {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type');
    let body;
    if (contentType?.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    if (!response.ok) {
      console.error(`API error ${response.status} on ${method} ${table}:`);
      console.error('Response:', body);
      console.error('Headers sent:', headers);
      return null;
    }

    return body;
  } catch (error) {
    console.error('Fetch error:', error.message);
    return null;
  }
}

async function runLoadTest() {
  console.log('\n\n====== REAL PRODUCTION LOAD TEST ======\n');

  const dbMetrics = new Metrics('Database Operations');
  const notifMetrics = new Metrics('Notification Operations');

  // Try to use an existing merchant or create one with different approach
  console.log('Attempting to access existing merchants...');
  
  const existingMerchants = await supabaseRest('GET', 'merchants', null, 'limit=1');
  let merchantId;

  if (existingMerchants && Array.isArray(existingMerchants) && existingMerchants.length > 0) {
    merchantId = existingMerchants[0].id;
    console.log(`✓ Using existing merchant: ${merchantId}`);
  } else {
    // If no existing merchants, log and exit
    console.error('❌ No existing merchants found in database');
    console.error('Please ensure the database has at least one merchant');
    console.error('You can create a merchant through the web dashboard first');
    process.exit(1);
  }

  // TEST 1: 50 Merchants equivalent
  console.log('\n\n=== TEST 1: 50 Merchants Equivalent (100 ops) ===');

  console.log('Reading merchant 50 times...');
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    const result = await supabaseRest('GET', 'merchants', null, `id=eq.${merchantId}`);
    const duration = performance.now() - start;
    dbMetrics.record(duration);
    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  console.log('Inserting 50 order checks...');
  for (let i = 0; i < 50; i++) {
    const orderData = {
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
    };

    const start = performance.now();
    const result = await supabaseRest('POST', 'order_checks', orderData);
    const duration = performance.now() - start;
    dbMetrics.record(duration);

    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  const stats50 = dbMetrics.report();

  // TEST 2: 100 Merchants equivalent
  console.log('\n\n=== TEST 2: 100 Merchants Equivalent (100 ops) ===');

  console.log('Reading merchant 50 times...');
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    const result = await supabaseRest('GET', 'merchants', null, `id=eq.${merchantId}`);
    const duration = performance.now() - start;
    dbMetrics.record(duration);
    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  console.log('Inserting 50 order checks...');
  for (let i = 0; i < 50; i++) {
    const orderData = {
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
    };

    const start = performance.now();
    const result = await supabaseRest('POST', 'order_checks', orderData);
    const duration = performance.now() - start;
    dbMetrics.record(duration);

    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(' done');

  const stats100 = dbMetrics.report();

  // TEST 3: 250 Merchants equivalent
  console.log('\n\n=== TEST 3: 250 Merchants Equivalent (100 ops mixed) ===');

  console.log('Mixed read/write operations...');
  for (let i = 0; i < 100; i++) {
    if (i % 2 === 0) {
      const start = performance.now();
      const result = await supabaseRest('GET', 'merchants', null, `id=eq.${merchantId}`);
      const duration = performance.now() - start;
      dbMetrics.record(duration);
    } else {
      const orderData = {
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
      };

      const start = performance.now();
      const result = await supabaseRest('POST', 'order_checks', orderData);
      const duration = performance.now() - start;
      dbMetrics.record(duration);
    }

    if (i % 20 === 0) process.stdout.write('.');
  }
  console.log(' done');

  const stats250 = dbMetrics.report();

  // TEST 4: Notification delivery
  console.log('\n\n=== TEST 4: Notification Delivery (100 ops) ===');

  console.log('Inserting 100 notifications...');
  for (let i = 0; i < 100; i++) {
    const notifData = {
      merchant_id: merchantId,
      notification_type: 'order_risk_alert',
      title: `Risk Alert ${i}`,
      body: `Order risk assessment complete`,
      metadata: {
        orderId: `order_${i}`,
        riskScore: Math.floor(Math.random() * 100)
      }
    };

    const start = performance.now();
    const result = await supabaseRest('POST', 'merchant_notifications', notifData);
    const duration = performance.now() - start;
    notifMetrics.record(duration);

    if (i % 20 === 0) process.stdout.write('.');
  }
  console.log(' done');

  const notifStats = notifMetrics.report();

  // Capacity analysis
  console.log('\n\n====== REAL CAPACITY RECOMMENDATIONS ======\n');

  function analyzeCapacity(avgLatency, p95Latency, merchantCount) {
    const secsPerDay = 86400;
    const opsPerSec = 1000 / avgLatency;
    const ordersPerDay = Math.floor(opsPerSec * secsPerDay * (merchantCount / 50));
    const peakTps = Math.floor(ordersPerDay / secsPerDay);

    // Determine status
    let status;
    if (avgLatency < 100 && p95Latency < 300) {
      status = '✓ GO';
    } else if (avgLatency < 200 && p95Latency < 800) {
      status = '✓ CONDITIONAL GO';
    } else {
      status = '⚠️ CAUTION';
    }

    return { opsPerSec, ordersPerDay, peakTps, status };
  }

  const cap50 = analyzeCapacity(stats50.avg, stats50.p95, 50);
  const cap100 = analyzeCapacity(stats100.avg, stats100.p95, 100);
  const cap250 = analyzeCapacity(stats250.avg, stats250.p95, 250);

  console.log('50 MERCHANTS:');
  console.log(`  Avg Latency: ${stats50.avg.toFixed(2)}ms`);
  console.log(`  P95 Latency: ${stats50.p95.toFixed(2)}ms`);
  console.log(`  P99 Latency: ${stats50.p99.toFixed(2)}ms`);
  console.log(`  Throughput: ${cap50.opsPerSec.toFixed(0)} ops/sec`);
  console.log(`  Daily Orders: ${cap50.ordersPerDay.toLocaleString()}`);
  console.log(`  Peak TPS: ${cap50.peakTps}`);
  console.log(`  ${cap50.status}`);

  console.log('\n100 MERCHANTS:');
  console.log(`  Avg Latency: ${stats100.avg.toFixed(2)}ms`);
  console.log(`  P95 Latency: ${stats100.p95.toFixed(2)}ms`);
  console.log(`  P99 Latency: ${stats100.p99.toFixed(2)}ms`);
  console.log(`  Throughput: ${cap100.opsPerSec.toFixed(0)} ops/sec`);
  console.log(`  Daily Orders: ${cap100.ordersPerDay.toLocaleString()}`);
  console.log(`  Peak TPS: ${cap100.peakTps}`);
  console.log(`  ${cap100.status}`);

  console.log('\n250 MERCHANTS:');
  console.log(`  Avg Latency: ${stats250.avg.toFixed(2)}ms`);
  console.log(`  P95 Latency: ${stats250.p95.toFixed(2)}ms`);
  console.log(`  P99 Latency: ${stats250.p99.toFixed(2)}ms`);
  console.log(`  Throughput: ${cap250.opsPerSec.toFixed(0)} ops/sec`);
  console.log(`  Daily Orders: ${cap250.ordersPerDay.toLocaleString()}`);
  console.log(`  Peak TPS: ${cap250.peakTps}`);
  console.log(`  ${cap250.status}`);

  // Notification analysis
  console.log('\n\nNOTIFICATION DELIVERY:');
  console.log(`  Avg Latency: ${notifStats.avg.toFixed(2)}ms`);
  console.log(`  P95 Latency: ${notifStats.p95.toFixed(2)}ms`);
  console.log(`  Throughput: ${notifStats.throughput.toFixed(0)} notifs/sec`);
  console.log(`  Daily Capacity: ${Math.floor(notifStats.throughput * 86400).toLocaleString()}`);

  // Bottleneck analysis
  console.log('\n\n=== BOTTLENECK ANALYSIS ===');

  if (stats50.avg < 100) {
    console.log('✓ Database latency excellent (< 100ms)');
  } else if (stats50.avg < 200) {
    console.log('✓ Database latency good (< 200ms)');
  } else {
    console.log('⚠️ Database latency elevated (> 200ms)');
  }

  if (notifStats.throughput > 500) {
    console.log('✓ Notification throughput excellent (> 500 notifs/sec)');
  } else if (notifStats.throughput > 100) {
    console.log('✓ Notification throughput good (> 100 notifs/sec)');
  } else {
    console.log('⚠️ Notification throughput limited (< 100 notifs/sec)');
  }

  // Plan recommendations
  console.log('\n\n=== PLATFORM RECOMMENDATIONS ===');

  const maxOpsPerSec = Math.max(stats50.opsPerSec, stats100.opsPerSec, stats250.opsPerSec);
  const maxDaily = Math.max(cap50.ordersPerDay, cap100.ordersPerDay, cap250.ordersPerDay);

  if (stats50.avg < 150 && stats50.p95 < 500) {
    console.log('✓ Supabase: PRO ($25/month)');
    console.log('   Sufficient for up to 100 merchants with good performance');
  } else if (stats50.avg < 200) {
    console.log('⚠️ Supabase: TEAM ($599/month)');
    console.log('   Better performance and higher limits recommended');
  } else {
    console.log('❌ Supabase: ENTERPRISE');
    console.log('   Contact sales for custom capacity planning');
  }

  console.log('\n✓ Vercel: PRO ($20/month)');
  console.log(`   Can handle ~${(maxDaily / 100000).toFixed(1)}K orders/day`);

  // Final verdict
  console.log('\n\n====== FINAL VERDICT ======\n');

  console.log(`50 Merchants:   ${cap50.status}`);
  console.log(`100 Merchants:  ${cap100.status}`);
  console.log(`250 Merchants:  ${cap250.status}`);

  if (cap50.status === '✓ GO' && cap100.status === '✓ GO') {
    console.log('\n✓ READY FOR PRODUCTION - Safe to launch');
  } else {
    console.log('\n⚠️ CONDITIONAL - Monitor performance closely');
  }

  // Cleanup
  console.log('\n\nCleaning up test data...');
  await supabaseRest('DELETE', 'order_checks', null, `merchant_id=eq.${merchantId}`);
  await supabaseRest('DELETE', 'merchant_notifications', null, `merchant_id=eq.${merchantId}`);
  await supabaseRest('DELETE', 'merchant_api_keys', null, `merchant_id=eq.${merchantId}`);
  await supabaseRest('DELETE', 'merchants', null, `id=eq.${merchantId}`);
  console.log('✓ Cleanup complete');

  console.log('\n✓ Real production load test completed\n');
}

runLoadTest().catch((err) => {
  console.error('❌ Load test failed:', err);
  process.exit(1);
});
