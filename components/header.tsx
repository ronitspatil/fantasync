"use client"

import { FinbroLogo } from "@/components/finbro-logo"
import { SyncLeague } from "@/components/sync-league"
import { Unlink, User } from 'lucide-react'
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSync } from "@/lib/sync-context"
import { avatarUrl } from "@/lib/sleeper"

export function Header() {
  const { user, status, disconnect } = useSync()
  const synced = status === "synced" && user
  const pfp = synced ? avatarUrl(user.avatar, true) : null

  return (
    <header className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between gap-3 px-4 py-4 md:p-6 bg-black/10 backdrop-blur-[120px]">
      <div className="flex min-w-0 items-center gap-2.5">
        <FinbroLogo className="text-white h-10 w-auto" />
      </div>
      <div className="flex shrink-0 items-center gap-2 md:gap-3">
        <SyncLeague />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="h-10 w-10 rounded-full bg-black border border-white flex items-center justify-center overflow-hidden outline-none transition-colors hover:border-[#a5f3fc] focus-visible:border-[#a5f3fc]"
              aria-label={synced ? "Open synced profile menu" : "Profile"}
            >
              {pfp ? (
                <Avatar key={pfp} className="h-full w-full">
                  <AvatarImage src={pfp} alt={user?.display_name ?? ""} />
                  <AvatarFallback className="bg-black">
                    <User className="h-6 w-6 text-white" />
                  </AvatarFallback>
                </Avatar>
              ) : (
                <User className="h-6 w-6 text-white" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-48 border-[#2A2A2A] bg-[#0D0D0D] p-1 text-[#E7E7E7]"
          >
            {synced ? (
              <>
                <DropdownMenuLabel className="px-3 py-2">
                  <div className="truncate text-sm font-semibold text-white">{user.display_name}</div>
                  <div className="truncate text-xs font-normal text-[#919191]">@{user.username}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-[#1F1F1F]" />
                <DropdownMenuItem
                  onClick={disconnect}
                  className="cursor-pointer rounded-md px-3 py-2 text-[#E7E7E7] focus:bg-[#151515] focus:text-white"
                >
                  <Unlink className="h-4 w-4" />
                  Unsync
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuLabel className="px-3 py-2 text-sm font-normal text-[#919191]">
                No league synced
              </DropdownMenuLabel>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
