
import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
}
const MODEL_NAME = 'gemini-embedding-001';

async function testEmbedding() {
    console.log(`Testing Gemini API with key: ${API_KEY.substring(0, 10)}...`);
    console.log(`Target Model: ${MODEL_NAME}`);

    try {
        const genAI = new GoogleGenerativeAI(API_KEY);
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });

        const result = await model.embedContent('Test embedding string');
        const embedding = result.embedding;

        console.log('✅ Success!');
        console.log(`Embedding length: ${embedding.values.length}`);
        console.log('First 5 values:', embedding.values.slice(0, 5));

    } catch (error) {
        console.error('❌ API Call Failed!');
        console.error(error);
    }
}

testEmbedding();
