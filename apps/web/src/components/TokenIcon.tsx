type TokenIconProps = {
  asset: string;
  size?: number;
};

function TokenArtwork({ asset }: { asset: string }) {
  switch (asset) {
    case "BTC":
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="#f7931a" />
          <text
            x="12"
            y="16.25"
            textAnchor="middle"
            fill="#fff"
            fontFamily="Arial, sans-serif"
            fontSize="13.5"
            fontWeight="700"
          >
            ₿
          </text>
        </>
      );
    case "SOL":
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="#0b0d12" />
          <path d="M6.2 6.25h10.9l1.7 1.8H7.9z" fill="#8c5cff" />
          <path d="M7.9 10.95h10.9l-1.7 1.8H6.2z" fill="#19d9b4" />
          <path d="M6.2 15.65h10.9l1.7 1.8H7.9z" fill="#8c5cff" />
        </>
      );
    case "USDT":
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="#26a17b" />
          <path
            d="M6.2 6.2h11.6v2.55h-4.45v1.5c3.36.17 5.85.82 5.85 1.6s-2.49 1.43-5.85 1.6v4.35h-2.7v-4.35c-3.36-.17-5.85-.82-5.85-1.6s2.49-1.43 5.85-1.6v-1.5H6.2V6.2Zm4.45 5.27c-2.1.12-3.61.43-3.61.8 0 .45 2.22.82 4.96.82s4.96-.37 4.96-.82c0-.37-1.51-.68-3.61-.8v.9a25.3 25.3 0 0 1-2.7 0v-.9Z"
            fill="#fff"
          />
        </>
      );
    case "BNB":
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="#f3ba2f" />
          <path
            d="m12 5.1 2.05 2.05L12 9.2 9.95 7.15 12 5.1Zm-3.5 3.5 2.05 2.05L8.5 12.7 6.45 10.65 8.5 8.6Zm7 0 2.05 2.05-2.05 2.05-2.05-2.05L15.5 8.6ZM12 10.05 13.95 12 12 13.95 10.05 12 12 10.05Zm0 4.75 2.05 2.05L12 18.9l-2.05-2.05L12 14.8Z"
            fill="#111318"
          />
        </>
      );
    case "ETH":
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="#627eea" />
          <path d="M12 4.25 7.55 12 12 14.55 16.45 12 12 4.25Z" fill="#fff" fillOpacity=".96" />
          <path d="m7.55 12.85 4.45 6.9 4.45-6.9L12 15.4l-4.45-2.55Z" fill="#fff" fillOpacity=".72" />
        </>
      );
    case "USDC":
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="#2775ca" />
          <circle cx="12" cy="12" r="7.25" fill="none" stroke="#fff" strokeWidth="1.5" strokeDasharray="13 4" />
          <text
            x="12"
            y="15.3"
            textAnchor="middle"
            fill="#fff"
            fontFamily="Arial, sans-serif"
            fontSize="10"
            fontWeight="700"
          >
            $
          </text>
        </>
      );
    default:
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="currentColor" />
          <text
            x="12"
            y="15.1"
            textAnchor="middle"
            fill="#fff"
            fontFamily="Arial, sans-serif"
            fontSize="7.5"
            fontWeight="700"
          >
            {asset.slice(0, 2)}
          </text>
        </>
      );
  }
}

export function TokenIcon({ asset, size = 34 }: TokenIconProps) {
  const normalized = asset.trim().toUpperCase();
  return (
    <span className="token-icon" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" role="presentation" focusable="false">
        <TokenArtwork asset={normalized} />
      </svg>
    </span>
  );
}
