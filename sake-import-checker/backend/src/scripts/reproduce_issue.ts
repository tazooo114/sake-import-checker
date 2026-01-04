
import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
}

// A simple 1x1 pixel white JPEG image base64
const BASE64_IMAGE = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwF/4A//2Q==';
const MIME_TYPE = 'image/jpeg';

const MODELS_TO_TEST = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
];

const EMBEDDING_MODEL = 'gemini-embedding-001';

async function testImageAnalysis(modelName: string) {
    console.log(`\nTesting Image Analysis: ${modelName}`);
    try {
        const genAI = new GoogleGenerativeAI(API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName });

        const prompt = 'Describe this image very briefly.';

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { mimeType: MIME_TYPE, data: BASE64_IMAGE } }
        ]);

        const text = result.response.text();
        console.log(`✅ Success! Response: ${text.trim()}`);
        return true;
    } catch (error: any) {
        console.error(`❌ Failed: ${error.message || error}`);
        return false;
    }
}

async function testEmbeddingDetailed() {
    console.log(`\nTesting Embedding Model: ${EMBEDDING_MODEL} (with outputDimensionality: 768)`);
    try {
        // Construct raw fetch request to verify outputDimensionality param support
        // because GoogleGenerativeAI SDK might abstract it or default it.
        // Actually, let's use the SDK first if it supports it, but the SDK embedContent method argument 
        // structure in the file I read ('verify_gemini.ts') didn't utilize outputDimensionality.
        // The service code DOES use outputDimensionality via fetch.
        // So I will emulate the SERVICE CODE's fetch approach exactly.

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${API_KEY}`;
        const text = "Test embedding";

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: `models/${EMBEDDING_MODEL}`,
                content: { parts: [{ text }] },
                outputDimensionality: 768
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error: ${response.status} ${errorText}`);
        }

        const data = await response.json() as any;
        console.log(`✅ Success! Embedding length: ${data.embedding.values.length}`);
        return true;

    } catch (error: any) {
        console.error(`❌ Failed: ${error.message || error}`);
        return false;
    }
}

async function runTests() {
    console.log('--- Testing Image Analysis (Vision) ---');
    for (const model of MODELS_TO_TEST) {
        await testImageAnalysis(model);
    }

    console.log('\n--- Testing Embedding (Service approach) ---');
    await testEmbeddingDetailed();
}

runTests();
