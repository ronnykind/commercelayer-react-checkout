import {
  getIntegrationToken,
  getSalesChannelToken,
} from "@commercelayer/js-auth"
import CommerceLayer, {
  CommerceLayerClient,
  Address,
  AddressCreate,
} from "@commercelayer/sdk"
import { test as base } from "@playwright/test"
import dotenv from "dotenv"

import path from "path"

import { CheckoutPage } from "./CheckoutPage"

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") })

type OrderType =
  | "plain"
  | "no_line_items"
  | "bundle"
  | "bundle+skus"
  | "digital"
  | "gift-card"
  | "with-items"

type LineItemObject = {
  quantity: number
} & ({ sku_code: string } | { bundle_code: string })

interface GiftCardProps {
  currency_code?: "EUR" | "USD"
  balance_cents?: number
  customer_email?: string
  apply?: boolean
}

interface DefaultParamsProps {
  token?: string
  orderId?: string
  order: OrderType | undefined
  orderAttributes?: {
    language_code?: "en" | "it"
    customer_email?: string
    shipping_country_code_lock?: "IT" | "GB" | "US"
  }
  lineItemsAttributes?: LineItemObject[]
  giftCardAttributes?: GiftCardProps
  addresses?: {
    billingAddress?: Partial<Address>
    shippingAddress?: Partial<Address>
    sameShippingAddress?: boolean
  }
  couponCode?: string
}

type FixtureType = {
  checkoutPage: CheckoutPage
  defaultParams: DefaultParamsProps
}

const getToken = async () => {
  const clientId = process.env.NEXT_PUBLIC_CLIENT_ID as string
  const endpoint = process.env.NEXT_PUBLIC_ENDPOINT as string
  const scope = process.env.NEXT_PUBLIC_MARKET_ID as string
  const { accessToken } = await getSalesChannelToken({
    clientId,
    endpoint,
    scope,
  })
  return accessToken as string
}

const getSuperToken = async () => {
  const clientId = process.env.NEXT_PUBLIC_INTEGRATION_CLIENT_ID as string
  const clientSecret = process.env
    .NEXT_PUBLIC_INTEGRATION_CLIENT_SECRET as string
  const endpoint = process.env.NEXT_PUBLIC_ENDPOINT as string
  const scope = process.env.NEXT_PUBLIC_MARKET_ID as string
  const { accessToken } = await getIntegrationToken({
    clientId,
    clientSecret,
    endpoint,
    scope,
  })
  return accessToken as string
}

const getOrder = async (
  cl: CommerceLayerClient,
  params: DefaultParamsProps
) => {
  const attributes = { ...params.orderAttributes }
  const giftCard = params.giftCardAttributes
  const order = await cl.orders.create(attributes)
  let giftCardCode

  switch (params.order) {
    case "plain":
      await createDefaultLineItem(cl, order.id)
      break
    case "with-items": {
      await createLineItems({
        cl,
        orderId: order.id,
        items: params.lineItemsAttributes || [],
      })
      if (giftCard) {
        const superToken = await getSuperToken()
        const superCl = await getClient(superToken)
        const card = await createAndPurchaseGiftCard(cl, giftCard)
        const activeCard = await superCl.gift_cards.update({
          id: card.id,
          _activate: true,
        })
        if (giftCard.apply) {
          await cl.orders.update({
            id: order.id,
            gift_card_code: activeCard.code,
          })
        } else {
          giftCardCode = activeCard.code
        }
      }
      if (params.couponCode) {
        await cl.orders.update({
          id: order.id,
          coupon_code: params.couponCode,
        })
      }
      if (params.addresses && params.addresses.billingAddress) {
        const { billingAddress, shippingAddress, sameShippingAddress } =
          params.addresses
        const addressToAttach = await cl.addresses.create(
          billingAddress as AddressCreate
        )
        await cl.orders.update({
          id: order.id,
          billing_address: cl.addresses.relationship(addressToAttach),
          _shipping_address_same_as_billing: sameShippingAddress,
        })
        if (!sameShippingAddress && shippingAddress) {
          const addressToAttach = await cl.addresses.create(
            shippingAddress as AddressCreate
          )
          await cl.orders.update({
            id: order.id,
            shipping_address: cl.addresses.relationship(addressToAttach),
          })
        }
      }

      break
    }
    case "bundle":
      await createLineItems({
        cl,
        orderId: order.id,
        items: [
          {
            bundle_code: "SHIRTSETSINGLE",
            quantity: 1,
          },
        ],
      })
      break
    case "bundle+skus":
      await createLineItems({
        cl,
        orderId: order.id,
        items: [
          {
            bundle_code: "SHIRTSETSINGLE",
            quantity: 1,
          },
          {
            sku_code: "TESLA5",
            quantity: 2,
          },
        ],
      })
      break

    case "digital": {
      await createLineItems({
        cl,
        orderId: order.id,
        items: [
          {
            sku_code: "NFTEBOOK",
            quantity: 1,
          },
        ],
      })
      break
    }
    case "gift-card": {
      const activeCard = await createAndPurchaseGiftCard(cl, giftCard)

      const lineItem = {
        quantity: 1,
        order: cl.orders.relationship(order),
        item: cl.gift_cards.relationship(activeCard),
      }

      await cl.line_items.create(lineItem)

      break
    }
  }
  return { orderId: order.id, attributes: { giftCard: giftCardCode } }
}

const createAndPurchaseGiftCard = async (
  cl: CommerceLayerClient,
  props?: GiftCardProps
) => {
  const card = await cl.gift_cards.create({
    currency_code: props?.currency_code ? props.currency_code : "EUR",
    balance_cents: props?.balance_cents ? props.balance_cents : 10000,
    recipient_email: props?.customer_email
      ? props.customer_email
      : "customer@tk.com",
  })
  const activeCard = await cl.gift_cards.update({
    id: card.id,
    _purchase: true,
  })
  return activeCard
}

const getClient = async (token: string) => {
  return CommerceLayer({
    organization: process.env.NEXT_PUBLIC_SLUG as string,
    accessToken: token,
  })
}

const createLineItems = async ({
  cl,
  orderId,
  items,
}: {
  cl: CommerceLayerClient
  orderId: string
  items: Array<LineItemObject>
}) => {
  const lineItems = items.map((item) => {
    const lineItem = {
      ...item,
      order: cl.orders.relationship(orderId),
    }

    return cl.line_items.create(lineItem)
  })

  try {
    await Promise.all(lineItems)
  } catch (e) {
    console.log(e)
  }
}

const createDefaultLineItem = async (
  cl: CommerceLayerClient,
  orderId: string
) => {
  const sku = (await cl.skus.list()).first()

  const lineItem = {
    sku_code: sku?.code,
    quantity: 1,
    order: cl.orders.relationship(orderId),
  }

  await cl.line_items.create(lineItem)
}

export const test = base.extend<FixtureType>({
  defaultParams: { order: "plain" },
  checkoutPage: async ({ page, defaultParams }, use) => {
    const token = await getToken()
    const cl = await getClient(token)
    const { orderId, attributes } = await getOrder(cl, defaultParams)
    const checkoutPage = new CheckoutPage(page, attributes)
    const id =
      defaultParams.orderId === undefined ? orderId : defaultParams.orderId
    const accessToken =
      defaultParams.token === undefined ? token : defaultParams.token
    await checkoutPage.goto({
      orderId: id,
      token: accessToken,
    })
    await use(checkoutPage)
  },
})

export { expect } from "@playwright/test"
