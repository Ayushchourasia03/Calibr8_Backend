export const runCode = async (req, res) => {
  try {
    const { source_code, language_id, stdin } = req.body;

    if (!source_code || source_code.length > 10000) {
      return res.status(400).json({ error: "Code empty or too big (10k max)" });
    }

    const response = await fetch(`${process.env.CODEBOX_URL}/submissions?wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': process.env.CODEBOX_TOKEN
      },
      body: JSON.stringify({
        source_code,
        language_id: language_id || 71,
        stdin: stdin || ""
      })
    });

    const result = await response.json();
    
    return res.json({
      stdout: result.stdout,
      stderr: result.stderr,
      compile_output: result.compile_output,
      time: result.time,
      memory: result.memory,
      status: result.status?.description || result.status
    });

  } catch (err) {
    console.error("Codebox error:", err);
    return res.status(500).json({ error: "Execution service down", details: err.message });
  }
};