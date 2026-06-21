"""AIRadar Python SDK.

Quick start::

    from airadar import AIRadarClient

    # Free endpoints (no payment needed)
    client = AIRadarClient()
    print(client.free())             # top 3 online providers
    print(client.gateway_models())   # 340+ models with pricing
    print(client.reputation("npub1..."))

    # Paid endpoints — wire up a Lightning callback
    def pay_invoice(bolt11: str) -> str:
        # pay using any Lightning library and return the preimage hex
        ...

    client = AIRadarClient(lightning=pay_invoice)
    results = client.search("latest AI news", n=5)
    response = client.chat("openai/gpt-4o", [{"role": "user", "content": "Hello"}])

    # LangChain tools
    from airadar.langchain_tools import create_airadar_tools
    tools = create_airadar_tools(client)
"""

from .client import AIRadarClient, AsyncAIRadarClient, AIRadarError

__all__ = ["AIRadarClient", "AsyncAIRadarClient", "AIRadarError"]
__version__ = "0.1.0"
