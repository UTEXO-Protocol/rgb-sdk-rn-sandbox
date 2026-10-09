import { Tabs } from 'expo-router';
import React from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { AppColors } from '@/constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: AppColors.primary,
        tabBarInactiveTintColor: AppColors.textTertiary,
        tabBarStyle: {
          backgroundColor: AppColors.bgCard,
          borderTopColor: AppColors.border,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          letterSpacing: 0.3,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Docs',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="book.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="flows"
        options={{
          title: 'Flows',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="play.circle.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="utexo"
        options={{
          title: 'Signet',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="play.circle.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="wallet"
        options={{
          title: 'Wallet',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="link" color={color} />,
        }}
      />
      <Tabs.Screen
        name="lsp"
        options={{
          title: 'LSP',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="play.circle.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}
