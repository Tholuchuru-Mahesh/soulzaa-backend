# Soulzaa Permission Naming Standard & Guidelines

This document outlines the standard permission naming conventions across all Soulzaa backend domain modules to ensure consistency, clarity, and future scalability.

## Permission Structure

All platform permission codes MUST follow the dot-namespaced pattern:

```
<domain>.[<subdomain>].<action>
```

### Components

1. **`domain`** (Required): The primary module or resource boundary (e.g. `user`, `wallet`, `room`, `agency`, `seller`, `event`, `analytics`, `gift`, `coin`, `game`, `vip`).
2. **`subdomain`** (Optional): Specific sub-domain or sub-feature when a module manages distinct sub-resources (e.g. `audio.room`, `video.room`, `room.seat`, `family.member`).
3. **`action`** (Required): Standardized verb describing the exact action being authorized.

---

## Standard Action Vocabulary

| Action Verb | Purpose / Use Case | Examples |
| :--- | :--- | :--- |
| `view` / `read` | Read / inspect resource details | `user.view`, `wallet.view`, `analytics.view` |
| `create` | Instantiating or creating new entities | `room.create`, `agency.create`, `event.create` |
| `update` | Modifying existing entity attributes | `user.update`, `room.update` |
| `delete` | Removing or soft-deleting entities | `user.delete`, `room.delete` |
| `adjust` | Balance or numeric adjustments | `wallet.adjust` |
| `approve` | Formal workflow approval | `agency.approve`, `seller.approve` |
| `reject` | Formal workflow rejection | `agency.reject`, `seller.reject` |
| `publish` | Making draft items live | `event.publish` |
| `ban` / `suspend` | Account suspension | `user.ban` |
| `mute` / `kick` | Real-time moderation actions | `room.mute`, `room.kick` |
| `manage` | Full administrative configuration | `gift.manage`, `coin.manage`, `vip.manage` |

---

## Subdomain Namespaced Examples for Future Modules

### Audio & Video Rooms
- `audio.room.create`
- `audio.room.close`
- `audio.room.delete`
- `video.room.create`
- `video.room.close`
- `video.room.delete`

### Financial & Wallet
- `wallet.view`
- `wallet.adjust`
- `wallet.freeze`

### Agency & Seller Portals
- `agency.create`
- `agency.approve`
- `agency.reject`
- `seller.approve`
- `seller.reject`

---

## Permission Categories

Every permission record MUST be assigned to one of the canonical **Permission Categories**:
- `USER`
- `ROOM`
- `AUDIO_ROOM`
- `VIDEO_ROOM`
- `WALLET`
- `GIFTS`
- `COIN`
- `VIP`
- `FAMILY`
- `GAME`
- `EVENT`
- `ANALYTICS`
- `AGENCY`
- `COIN_SELLER`
- `SYSTEM`
