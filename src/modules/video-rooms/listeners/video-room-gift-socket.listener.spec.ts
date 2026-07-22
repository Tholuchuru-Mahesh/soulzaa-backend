import { GiftContextType } from '@prisma/client';
import { VIDEO_ROOM_GIFT_EVENTS } from '../events/video-room-gift.events';
import { VideoRoomGiftSocketListener } from './video-room-gift-socket.listener';

type Handler = (event: { payload: Record<string, unknown> }) => void;

describe('VideoRoomGiftSocketListener', () => {
  let handlers: Record<string, Handler>;
  let bus: { subscribe: jest.Mock };
  let sockets: { emitToNamespaceRoom: jest.Mock; emitToUserEverywhere: jest.Mock };
  let listener: VideoRoomGiftSocketListener;

  const fire = (name: string, payload: Record<string, unknown>) => handlers[name]({ payload });

  const roomEmits = () =>
    sockets.emitToNamespaceRoom.mock.calls.map(([ns, roomId, event]) => ({ ns, roomId, event }));

  beforeEach(() => {
    handlers = {};
    bus = {
      subscribe: jest.fn((name: string, handler: Handler) => {
        handlers[name] = handler;
      }),
    };
    sockets = { emitToNamespaceRoom: jest.fn(), emitToUserEverywhere: jest.fn() };
    listener = new VideoRoomGiftSocketListener(bus as never, sockets as never);
    listener.onModuleInit();
  });

  describe('shared gifts-module events', () => {
    it('relays a VIDEO_ROOM gift.sent to the room namespace', () => {
      fire('gift.sent', {
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: 'r1',
        receiverId: 'u1',
      });
      expect(roomEmits()).toEqual([
        { ns: '/video-room', roomId: 'r1', event: 'video_room.gift_sent' },
      ]);
    });

    /** Without this filter, every audio-room gift would leak into video rooms. */
    it('IGNORES an AUDIO_ROOM gift.sent', () => {
      fire('gift.sent', {
        contextType: GiftContextType.AUDIO_ROOM,
        contextId: 'r1',
        receiverId: 'u1',
      });
      expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
      expect(sockets.emitToUserEverywhere).not.toHaveBeenCalled();
    });

    it('also notifies the receiver wherever they are', () => {
      fire('gift.sent', {
        contextType: GiftContextType.VIDEO_ROOM,
        contextId: 'r1',
        receiverId: 'u1',
      });
      expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
        'u1',
        'video_room.gift_sent',
        expect.anything(),
      );
    });

    it('IGNORES an AUDIO_ROOM combo and lucky win', () => {
      fire('gift.combo', { contextType: GiftContextType.AUDIO_ROOM, contextId: 'r1' });
      fire('gift.lucky_win', { contextType: GiftContextType.AUDIO_ROOM, contextId: 'r1' });
      expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
    });

    it('relays a VIDEO_ROOM lucky win as an animation', () => {
      fire('gift.lucky_win', { contextType: GiftContextType.VIDEO_ROOM, contextId: 'r1' });
      expect(roomEmits()[0].event).toBe('video_room.gift_animation');
    });
  });

  describe('video-room events', () => {
    it('relays the batch animation to the room', () => {
      fire(VIDEO_ROOM_GIFT_EVENTS.ANIMATION, { roomId: 'r1', batchId: 'b1' });
      expect(roomEmits()[0]).toEqual({
        ns: '/video-room',
        roomId: 'r1',
        event: 'video_room.gift_animation',
      });
    });

    it('relays delivery to the room AND cross-room to the receiver', () => {
      fire(VIDEO_ROOM_GIFT_EVENTS.DELIVERED, { roomId: 'r1', receiverId: 'u1' });
      expect(roomEmits()[0].event).toBe('video_room.gift_delivered');
      expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
        'u1',
        'video_room.gift_delivered',
        expect.anything(),
      );
    });

    /** Viewers never saw the animation, so a room-wide failure notice is noise. */
    it('sends a failure to the SENDER only, never the room', () => {
      fire(VIDEO_ROOM_GIFT_EVENTS.FAILED, {
        roomId: 'r1',
        senderId: 's1',
        reason: 'socket down',
      });
      expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalled();
      expect(sockets.emitToUserEverywhere).toHaveBeenCalledWith(
        's1',
        'video_room.gift_failed',
        expect.anything(),
      );
    });

    it('relays queue depth to the room', () => {
      fire(VIDEO_ROOM_GIFT_EVENTS.QUEUE_UPDATED, { roomId: 'r1', pending: 4, active: 1 });
      expect(roomEmits()[0].event).toBe('video_room.gift_queue_updated');
    });

    it('relays recovery to the room', () => {
      fire(VIDEO_ROOM_GIFT_EVENTS.RECOVERED, { roomId: 'r1', batchId: 'b1', jobId: 'j1' });
      expect(roomEmits()[0].event).toBe('video_room.gift_recovered');
    });

    it.each([
      [VIDEO_ROOM_GIFT_EVENTS.COMBO_STARTED, 'video_room.gift_combo_started'],
      [VIDEO_ROOM_GIFT_EVENTS.COMBO_UPDATED, 'video_room.gift_combo_updated'],
      [VIDEO_ROOM_GIFT_EVENTS.COMBO_ENDED, 'video_room.gift_combo_ended'],
    ])('relays %s to the room', (busEvent, socketEvent) => {
      fire(busEvent, { roomId: 'r1' });
      expect(roomEmits()[0].event).toBe(socketEvent);
    });
  });

  it('subscribes to every event it relays', () => {
    expect(Object.keys(handlers).sort()).toEqual(
      [
        'gift.combo',
        'gift.lucky_win',
        'gift.sent',
        VIDEO_ROOM_GIFT_EVENTS.ANIMATION,
        VIDEO_ROOM_GIFT_EVENTS.COMBO_ENDED,
        VIDEO_ROOM_GIFT_EVENTS.COMBO_STARTED,
        VIDEO_ROOM_GIFT_EVENTS.COMBO_UPDATED,
        VIDEO_ROOM_GIFT_EVENTS.DELIVERED,
        VIDEO_ROOM_GIFT_EVENTS.FAILED,
        VIDEO_ROOM_GIFT_EVENTS.QUEUE_UPDATED,
        VIDEO_ROOM_GIFT_EVENTS.RECOVERED,
      ].sort(),
    );
  });
});
