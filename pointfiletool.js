import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

const AI_MODEL = 'gpt-4';
const API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// Safely extract JSON object from AI response
function safeParseJson(str) {
  try {
    const match = str.match(/{[\s\S]*?}$/m);
    if (!match) throw new Error('No valid JSON object found.');
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Parse the raw text input into point entries
function parseRawDetails(raw) {
  const lines = raw.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l);
  if (lines.length < 2) return [];
  const groupName = lines[0];
  const detailLines = lines.slice(1);
  const entries = [];

  detailLines.forEach((line, idx) => {
    // Attempt AI typo-correction for "bits10-11" → "Bits 10-11"
    line = line.replace(/bits(\d+)/gi, 'Bits $1');

    const [offsetToken, typeToken, ...rest] = line.split(/\s+/);
    const offset = offsetToken;
    const type = typeToken === 'Integer' ? 'DI' : typeToken;
    const restText = rest.join(' ');

    // Bit-field detection
    if (/Bits?\s+\d/.test(restText)) {
      const segments = restText.split(/;|,(?=\s*Bits?\s+\d+)/).map(s => s.trim()).filter(Boolean);
      segments.forEach((segment, i) => {
        const match = segment.match(/Bits?\s*(\d+)(?:-(\d+))?:\s*([^;]+)/i);
        if (match) {
          const [, start, end, desc] = match;
          const bitsRange = end ? `${start}-${end}` : start;
          const tagBase = desc.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
          entries.push({
            offset,
            type,
            id: offset,           // read/write will share this
            tag: `${tagBase}_${i+1}`,
            label: desc.trim(),
            group: groupName,
            bits: bitsRange,
            bnd: '',
            evt: ''
          });
        }
      });
    } else {
      // Value mappings
      const mapRegex = /(\d+):\s*([^:]+)(?=\s+\d+:|$)/g;
      const mappings = [];
      let m;
      while ((m = mapRegex.exec(restText)) !== null) {
        mappings.push({ value: m[1], label: m[2].trim() });
      }
      const paramName = mappings.length
        ? restText.split(/\d+:/)[0].trim()
        : restText.trim();
      const tag = paramName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const evt = mappings.map(mp => `"${mp.label}"==${mp.value},0`).join(':');
      entries.push({ offset, type, id: offset, tag, label: paramName, group: groupName, bits: '', bnd: '', evt });
    }
  });

  return entries;
}

// Call OpenAI to auto-correct and enrich the parsed entries
async function analyzeWithAI(apiKey, text) {
  const response = await axios.post(API_ENDPOINT, {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: 'Auto-correct and enrich this table, return JSON { group, parameters: [{ offset, name, description, bits, values }] }' },
      { role: 'user', content: text }
    ],
    temperature: 0,
    max_tokens: 1000
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  });
  return response.data.choices[0].message.content;
}

// Merge AI-provided metadata into our entries
function enhanceWithAI(entries, aiData) {
  const aiJson = safeParseJson(aiData);
  if (!aiJson || !aiJson.parameters) return entries;

  return entries.map(entry => {
    const aiParam = aiJson.parameters.find(p => parseInt(p.offset) === parseInt(entry.offset));
    if (!aiParam) return entry;

    const evt = aiParam.values
      ? aiParam.values.map(v => `"${v.label}"==${v.value},0`).join(':')
      : entry.evt;

    return {
      ...entry,
      label: aiParam.name || entry.label,
      bits: aiParam.bits || entry.bits,
      evt,
      bnd: entry.bnd  // leave bnd alone for now
    };
  });
}

export default function AIPointFileGenerator() {
  const [rawDetails, setRawDetails] = useState('');
  const [useAI, setUseAI] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef();

  // Load history from localStorage
  useEffect(() => {
    const hist = localStorage.getItem('pfgen_history') || '';
    setRawDetails(hist);
  }, []);

  // Save history on change
  useEffect(() => {
    localStorage.setItem('pfgen_history', rawDetails);
  }, [rawDetails]);

  // Handle .txt file upload
  const onFileUpload = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => setRawDetails(evt.target.result);
    reader.readAsText(file);
  };

  // Copy generated output
  const copyOutput = () => {
    navigator.clipboard.writeText(output);
  };

  const generatePointFile = async () => {
    setLoading(true);
    try {
      let entries = parseRawDetails(rawDetails);
      if (useAI && apiKey) {
        const aiResp = await analyzeWithAI(apiKey, rawDetails);
        entries = enhanceWithAI(entries, aiResp);
      }
      // Build lines
      const lines = entries.map(e => {
        let line = `:SAFRAN_X:PNT: ${e.type}:${e.id}:${e.tag}:"${e.label}${e.bits ? ` [Bits ${e.bits}]` : ''}":grp "${e.group}"`;
        if (e.bnd) line += `:bnd ${e.bnd}`;
        if (e.evt) line += `:evt ${e.evt}`;
        return line + ':';
      });
      setOutput(lines.join('\n'));
    } catch (err) {
      setOutput(`// Error: ${err.message}`);
    }
    setLoading(false);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">AI-Powered Point File Generator</h1>

      <div className="space-y-2">
        <label className="block">Paste Configuration Table or Upload .txt:</label>
        <textarea
          rows={6}
          value={rawDetails}
          onChange={e => setRawDetails(e.target.value)}
          className="w-full p-2 font-mono border rounded"
        />
        <input
          type="file"
          accept=".txt"
          ref={fileInputRef}
          onChange={onFileUpload}
          className="mt-1"
        />
      </div>

      <div className="flex items-center space-x-4">
        <label>
          <input
            type="checkbox"
            checked={useAI}
            onChange={e => setUseAI(e.target.checked)}
          />{' '}
          Enable AI Correction
        </label>
        {useAI && (
          <input
            type="password"
            placeholder="OpenAI API Key"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            className="p-2 border rounded"
          />
        )}
      </div>

      <div className="flex space-x-2">
        <button
          onClick={generatePointFile}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
        >
          {loading ? 'Generating…' : 'Generate Point File'}
        </button>
        <button
          onClick={copyOutput}
          disabled={!output}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-400"
        >
          Copy Output
        </button>
      </div>

      <textarea
        readOnly
        rows={10}
        value={output}
        className="w-full p-2 font-mono border rounded"
        placeholder="Generated .pnt content…"
      />
    </div>
  );
}
