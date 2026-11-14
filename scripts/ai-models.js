import 'dotenv/config';

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${process.env.GOOGLE_API_KEY}`,
);
const { models = [] } = await res.json();
for (const m of models) {
  if (m.supportedGenerationMethods?.includes('generateContent')) {
    console.log(m.name.replace('models/', ''));
  }
}