// scripts/test-harness.mjs — Offline dry-run test harness for Etsy AI Agent

import fs from 'fs';
import path from 'path';

// ── Mock Chrome API Environment ──
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const mockDb = {
          etsyShopId: '12345678',
          etsyApiKey: 'mock-api-key-5678',
          etsyWarehouseType: 'Etsy 自发货',
          etsyTargetMargin: '25',
          settings: {
            apiKey: process.env.DASHSCOPE_API_KEY || process.env.GEMINI_API_KEY || 'mock-llm-key',
          }
        };
        const res = {};
        if (Array.isArray(keys)) {
          keys.forEach(k => { res[k] = mockDb[k]; });
        } else if (typeof keys === 'string') {
          res[keys] = mockDb[keys];
        } else {
          Object.assign(res, mockDb);
        }
        cb(res);
      },
      set: (data, cb) => { if (cb) cb(); }
    }
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.etsy.com/listing/123456789/personalized-gift/' }],
    get: (id, cb) => cb({ id: 1, windowId: 1, url: 'https://www.etsy.com/listing/123456789/personalized-gift/' }),
    captureVisibleTab: (windowId, options, cb) => cb('data:image/jpeg;base64,mock')
  },
  runtime: {
    getURL: (filePath) => filePath,
    onConnect: { addListener: () => {} },
    onMessage: { addListener: () => {} }
  }
};

// ── Mock Fetch to load local skill files in Node ──
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (typeof url === 'string' && !url.startsWith('http')) {
    const filePath = path.resolve(url);
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      ok: true,
      text: async () => content,
      json: async () => JSON.parse(content),
      status: 200,
    };
  }
  return originalFetch(url, options);
};

// ── Import Agent Loop & Start Offline Dry Run ──
async function main() {
  console.log("⚡ Starting Etsy AI Agent Offline Dry-Run Harness...");
  
  const { runAgentLoop } = await import('../modules/agentLoop.js');

  const mockPageContext = {
    url: "https://www.etsy.com/listing/123456789/personalized-gift/",
    title: "Personalized Wedding Clutch - Handmade Gift",
    h1: "Personalized Satin Wedding Clutch",
    price: "2 990 $",
    rating: "4.8",
    reviewCount: "420 reviews",
    description: "Handmade satin clutch for brides, bridesmaids, wedding guests, and personalized gift occasions.",
    images: [
      { src: "https://i.etsystatic.com/123456/r/il/mock.jpg", roleHint: "product_media", searchScore: 800 }
    ],
    productCards: []
  };

  const skillPath = "skills/etsy_product_opportunity_explorer.skill.md";
  const skillMarkdown = fs.readFileSync(skillPath, 'utf-8');

  console.log("🤖 Dispatching Agent Loop on Etsy toothbrush product page mock context...");
  
  try {
    const result = await runAgentLoop({
      tabId: 1,
      skillId: skillPath,
      skillMarkdown: skillMarkdown,
      userInstruction: "审计该电动牙刷的选品可行性与CE/CPC/FDA/IP认证风险",
      pageContext: mockPageContext,
      sendProgress: (progress) => {
        if (progress.type === 'thinking') {
          console.log(`  [Thinking] Step ${progress.step}: ${progress.message || ''}`);
        } else if (progress.type === 'tool_call') {
          console.log(`  [Tool Call] Executing: ${progress.toolName}`);
        } else if (progress.type === 'reflection') {
          console.log(`  [Critic Reflection] Audit Alert: ${progress.message}`);
        }
      },
      continueSession: false,
      highRandomness: false,
      negativeFilter: true,
    });

    console.log("\n🎉 Harness Run Completed successfully!");
    console.log("=========================================");
    console.log(JSON.stringify(result, null, 2));
    
  } catch (err) {
    console.error("❌ Harness Run failed:", err.message);
    process.exit(1);
  }
}

main();
