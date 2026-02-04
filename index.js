// functions/index.js
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require("cors")({origin: true});

// Initialize admin (for future use if you want Firestore, etc.)
if (!admin.apps.length) {
  admin.initializeApp();
}

/**
 * Simple English stopword set
 */
const STOPWORDS = new Set(
  "a,about,above,after,again,against,all,am,an,and,any,are,as,at,be," +
  "because,been,before,being,below,between,both,but,by,could,did,do,does," +
  "doing,down,during,each,few,for,from,further,had,has,have,having,he,her," +
  "here,hers,him,his,how,i,if,in,into,is,it,its,itself,just,me,more,most," +
  "my,myself,no,nor,not,of,off,on,once,only,or,other,ought,our,ours,ourselves," +
  "out,over,own,same,she,should,so,some,such,than,that,the,their,theirs,them," +
  "themselves,then,there,these,they,this,those,through,to,too,under,until,up," +
  "very,was,we,were,what,when,where,which,while,who,whom,why,with,would,you," +
  "your,yours,yourself,yourselves"
    .split(",")
);

/**
 * Normalize text: lower-case, remove weird quotes & punctuation
 */
function normalizeText(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^a-z0-9\s+#\-_]/g, " "); // keep letters, digits, +,#,-,_
}

/**
 * Tokenize and filter stopwords
 */
function tokenize(text, {minLen = 2} = {}) {
  const normalized = normalizeText(text);
  const parts = normalized.split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const t of parts) {
    if (t.length < minLen) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue; // skip pure numbers
    tokens.push(t);
  }
  return tokens;
}

/**
 * Build term frequency map
 */
function buildFrequency(tokens) {
  const freq = Object.create(null);
  for (const t of tokens) {
    freq[t] = (freq[t] || 0) + 1;
  }
  return freq;
}

/**
 * Cosine similarity between two frequency maps
 */
function cosineSimilarity(freqA, freqB) {
  const keys = new Set([...Object.keys(freqA), ...Object.keys(freqB)]);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const k of keys) {
    const a = freqA[k] || 0;
    const b = freqB[k] || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Extract top-K keywords from tokens (by frequency)
 */
function extractTopKeywords(tokens, topK = 200) {
  const freq = buildFrequency(tokens);
  const entries = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([token]) => token);
  return entries;
}

/**
 * Match JD keywords vs Resume keywords
 */
function matchKeywords(jdKeywords, resumeKeywords) {
  const jdSet = new Set(jdKeywords);
  const resumeSet = new Set(resumeKeywords);

  const matched = [];
  const missing = [];

  jdSet.forEach((k) => {
    if (resumeSet.has(k)) matched.push(k);
    else missing.push(k);
  });

  const jdCount = jdSet.size;
  const resumeCount = resumeSet.size;
  const overlapPct = jdCount === 0 ? 0 : (matched.length / jdCount) * 100;

  return {matched, missing, jdCount, resumeCount, overlapPct};
}

/**
 * Generate human-readable feedback
 */
function generateFeedback({score, overlapPct, missing}) {
  const feedback = [];

  if (score >= 85) {
    feedback.push("Excellent fit — the resume is highly aligned with the job description.");
  } else if (score >= 65) {
    feedback.push("Good fit — candidate is a strong match with a few improvement areas.");
  } else if (score >= 40) {
    feedback.push("Partial fit — some relevant skills present but there are notable gaps.");
  } else {
    feedback.push("Low fit — there are significant gaps in alignment with this role.");
  }

  if (missing.length > 0 && missing.length <= 8) {
    feedback.push(`Missing important keywords/skills: ${missing.join(", ")}.`);
  } else if (missing.length > 8) {
    const top = missing.slice(0, 8);
    feedback.push(
      `Missing ${missing.length} JD keywords. Key missing skills: ${top.join(", ")}.`
    );
  } else {
    feedback.push("No major JD keywords appear to be missing in the resume.");
  }

  if (score < 85) {
    feedback.push(
      "Consider tailoring the resume by explicitly mentioning relevant tools, technologies, and responsibilities from the JD."
    );
  } else {
    feedback.push("Candidate looks ready for this role. Focus the interview on depth and real projects.");
  }

  return feedback;
}

/**
 * Main HTTP function: POST { jd_text, resume_text }
 */
exports.matchJDandResume = functions
  .region("us-central1")
  .https.onRequest((req, res) => {
    cors(req, res, async () => {
      if (req.method !== "POST") {
        return res.status(405).json({error: "Only POST is allowed"});
      }

      const {jd_text, resume_text} = req.body || {};
      if (!jd_text || !resume_text) {
        return res.status(400).json({
          error: "Both 'jd_text' and 'resume_text' are required in the request body.",
        });
      }

      try {
        // 1) Tokenize
        const jdTokens = tokenize(jd_text, {minLen: 2});
        const resumeTokens = tokenize(resume_text, {minLen: 2});

        // 2) Keyword lists
        const jdKeywords = extractTopKeywords(jdTokens, 200);
        const resumeKeywords = extractTopKeywords(resumeTokens, 400);

        // 3) Keyword overlap
        const {
          matched,
          missing,
          jdCount,
          resumeCount,
          overlapPct,
        } = matchKeywords(jdKeywords, resumeKeywords);

        // 4) Cosine similarity (as a simple semantic metric)
        const jdFreq = buildFrequency(jdTokens);
        const resumeFreq = buildFrequency(resumeTokens);
        const semanticSimilarity = cosineSimilarity(jdFreq, resumeFreq); // 0..1

        // 5) Combine into final score
        // Tune these weights as you like:
        const semanticWeight = 0.6;
        const keywordWeight = 0.4;

        const semanticScorePct = semanticSimilarity * 100;
        const finalScore =
          semanticScorePct * semanticWeight + overlapPct * keywordWeight; // 0..100
        const matchScore = Math.round(finalScore * 100) / 100; // 2 decimals

        // 6) Generate feedback
        const feedback = generateFeedback({
          score: matchScore,
          overlapPct,
          missing,
        });

        return res.status(200).json({
          match_score: matchScore,                 // overall %
          semantic_similarity: semanticSimilarity, // 0..1
          overlap_pct: overlapPct,                // JD coverage %
          skills_matched: matched,
          missing_skills: missing,
          jd_skill_count: jdCount,
          resume_skill_count: resumeCount,
          feedback,
        });
      } catch (err) {
        console.error("Error in matchJDandResume:", err);
        return res.status(500).json({
          error: "Internal error computing match.",
          details: err.message,
        });
      }
    });
  });
