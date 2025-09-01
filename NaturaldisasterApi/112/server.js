require("dotenv").config();
const fetch = require("node-fetch");
const fs = require("fs");

const BEARER = process.env.X_BEARER_TOKEN;
const BASE = "https://api.x.com/2";

async function xget(path, params = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BEARER}` },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  // 1) Resolve user id
  const u = await xget("/users/by/username/112Greece");
  const userId = u.data.id;

  // 2) Get latest tweets
  const params = {
    max_results: "10",
    exclude: "retweets,replies",
    "tweet.fields": "created_at,lang,entities,geo,public_metrics",
  };

  const data = await xget(`/users/${userId}/tweets`, params);
  const tweets = data.data || [];

  console.log(`Fetched ${tweets.length} tweets from @112Greece:\n`);
  for (const t of tweets) {
    console.log(`[${t.created_at}] ${t.text}\n`);
  }
  

  fs.writeFileSync("tweets.json", JSON.stringify(tweets, null, 2), "utf-8");
  console.log(`Saved ${tweets.length} tweets to tweets.json`);

}

main().catch(err => console.error("Error:", err));
