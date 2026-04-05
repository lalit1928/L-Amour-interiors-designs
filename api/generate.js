export default async function handler(req, res) {
  const API_KEY = "r8_M5p18AbWpQu5jR5cFyadj0vs5UTTy2S3cMYUi";

  try {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        version: "db21e45c8c2e6f1b0d1c2b6f0e4d4e6f6d7a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
        input: {
          prompt: "luxury interior design, ultra realistic, 8k"
        }
      })
    });

    const data = await response.json();

    res.status(200).json({
      image: "https://source.unsplash.com/800x600/?luxury,interior",
      description:
