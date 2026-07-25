export function FinbroLogo({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-baseline font-bold tracking-tight leading-none text-[1.6rem] sm:text-[2rem] md:text-[2.25rem] select-none ${className ?? ""}`}
    >
      FANTA
      <span className="bg-gradient-to-r from-white from-10% to-[#a5f3fc] to-75% bg-clip-text text-transparent">SY</span>
      <span className="text-[#a5f3fc]">NC</span>
    </span>
  )
}
