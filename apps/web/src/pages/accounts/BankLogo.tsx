import { useState } from "react";
import { bankLogoUrl } from "../../api";
import { bankInitials } from "../../lib/connection-state";

/**
 * The bank's logo through the server proxy, or its initials when the bank has no logo or the
 * image fails. Decorative: the bank name is always written next to it.
 */
export function BankLogo({
  name,
  country,
  hasLogo,
}: {
  name: string;
  country: string;
  hasLogo: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl border border-subtle bg-surface-2 text-sm font-semibold text-primary"
    >
      {hasLogo && !failed ? (
        <img
          src={bankLogoUrl(country, name)}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          className="size-full object-contain p-1.5"
          onError={() => setFailed(true)}
        />
      ) : (
        bankInitials(name)
      )}
    </span>
  );
}
