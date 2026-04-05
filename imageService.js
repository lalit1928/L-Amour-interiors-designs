// imageService.js

export async function generateImage(prompt) {
  const API_KEY = "PASTE_YOUR_REPLICATE_KEY_HERE";

  try {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "db21e45c8c2e6f1b0d1c2b6f0e4d4e6f6d7a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
        input: {
          prompt: prompt,
        },
      }),
    });

    const data = await response.json();

    let result = data;
    while (result.status !== "succeeded") {
      const poll = await fetch(result.urls.get, {
        headers: {
          "Authorization": `Token ${API_KEY}`,
        },
      });
      result = await poll.json();
      await new Promise(r => setTimeout(r, 2000));
    }

    return result.output[0];
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}
