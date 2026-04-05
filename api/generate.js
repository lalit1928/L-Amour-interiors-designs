export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt } = req.body;

    const imageUrl = "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6";

    res.status(200).json({
      image: imageUrl,
      description: `Interior design based on: ${prompt}`
    });

  } catch (error) {
    res.status(500).json({ error: "Failed to generate image" });
  }
}
